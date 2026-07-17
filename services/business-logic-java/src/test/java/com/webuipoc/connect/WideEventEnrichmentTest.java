package com.webuipoc.connect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.avaje.jsonb.JsonType;
import io.avaje.jsonb.Jsonb;
import io.helidon.webserver.WebServer;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import todo.v1.TodoOuterClass;

/**
 * End-to-end enrichment test: a real Helidon server running the actual
 * {@link WideEventFeature} + {@link ConnectUnaryFeature} over {@link StubTodoService},
 * asserting that {@link ConnectUnaryHandler} enriches the wide event registered by
 * the filter — {@code rpc_method} on every RPC and {@code connect_code} on a failed
 * one. This is the wiring the adapter's own module cannot test (it has no generated
 * proto/service on its classpath); the stub drives the outcomes here.
 */
class WideEventEnrichmentTest {

    private static final String GET_TODO = "/todo.v1.TodoService/GetTodo";
    private static final String GET_TODO_METHOD = "todo.v1.TodoService/GetTodo";
    private static final String OK_ID = "8b3e1a1e-6f2a-4b57-9f3e-2d4c5a6b7c8d";

    private static final ByteArrayOutputStream CAPTURED = new ByteArrayOutputStream();
    private static WebServer server;
    private static HttpClient client;

    private final JsonType<WideEvent> eventType =
            Jsonb.builder().serializeNulls(true).build().type(WideEvent.class);

    @BeforeAll
    static void startServer() {
        PrintStream out = new PrintStream(CAPTURED, true, StandardCharsets.UTF_8);
        server = WebServer.builder()
                .port(0)
                .routing(routing -> {
                    routing.addFeature(WideEventFeature.create("business-logic-java", out));
                    routing.addFeature(ConnectUnaryFeature.create(new StubTodoService()));
                })
                .build()
                .start();
        client = HttpClient.newHttpClient();
    }

    @AfterAll
    static void stopServer() {
        client.close();
        server.stop();
    }

    @BeforeEach
    void resetCapture() {
        CAPTURED.reset();
    }

    private void getTodo(String id) throws Exception {
        byte[] body =
                TodoOuterClass.GetTodoRequest.newBuilder().setId(id).build().toByteArray();
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + server.port() + GET_TODO))
                .header("Content-Type", "application/proto")
                .header("Connect-Protocol-Version", "1")
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();
        client.send(request, HttpResponse.BodyHandlers.ofByteArray());
    }

    private WideEvent awaitSingleEvent() throws Exception {
        long deadline = System.nanoTime() + 2_000_000_000L;
        String captured = "";
        while (System.nanoTime() < deadline) {
            captured = CAPTURED.toString(StandardCharsets.UTF_8);
            if (captured.contains("\n")) {
                break;
            }
            Thread.sleep(5);
        }
        List<String> lines = Arrays.stream(captured.split("\n"))
                .filter(line -> !line.isBlank())
                .toList();
        assertEquals(1, lines.size(), "exactly one wide-event line per request, got: " + captured);
        return eventType.fromJson(lines.get(0));
    }

    @Test
    void enrichesRpcMethodAndNoCodeOnSuccess() throws Exception {
        getTodo(OK_ID);
        WideEvent event = awaitSingleEvent();
        assertEquals(200, event.getStatus());
        assertEquals(GET_TODO_METHOD, event.getRpcMethod(), "rpc_method is enriched from the descriptor");
        assertEquals("business-logic-java", event.getComponent());
        assertNull(event.getConnectCode(), "no connect_code on a successful RPC");
    }

    @Test
    void enrichesConnectCodeOnNotFound() throws Exception {
        getTodo(StubTodoService.MISSING_ID);
        WideEvent event = awaitSingleEvent();
        assertEquals(404, event.getStatus());
        assertEquals("not_found", event.getConnectCode(), "connect_code enrichment lands on an error response");
        assertEquals(GET_TODO_METHOD, event.getRpcMethod());
        assertTrue(event.getTraceId().matches("[0-9a-f]{32}"), "generated trace id");
    }
}
