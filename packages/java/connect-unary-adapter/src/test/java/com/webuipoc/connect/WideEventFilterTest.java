package com.webuipoc.connect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.avaje.jsonb.JsonType;
import io.avaje.jsonb.Jsonb;
import io.helidon.http.Status;
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

/**
 * Lifecycle tests for {@link WideEventFilter} over a real Helidon
 * {@link WebServer}: it emits exactly one well-formed wide-event line to the
 * injected stream on every request (success, enriched Connect error, and a
 * thrown-exception 500), with sane timing and correct trace adoption.
 *
 * <p>Why a captured {@link PrintStream} rather than capturing the failsafe IT
 * suite's real stdout: the failsafe boot runs in-process and interleaving its
 * server stdout with the test runner's is brittle; injecting the stream via
 * {@link WideEventFeature}'s test factory exercises the identical production code
 * path (the real filter over a real server) while keeping the assertion
 * deterministic. The end-to-end "real stdout" proof is done in the boot check.
 */
class WideEventFilterTest {

    private static final String TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
    private static final String INBOUND_PARENT = "00f067aa0ba902b7";
    private static final String TRACEPARENT = "00-" + TRACE_ID + "-" + INBOUND_PARENT + "-01";

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
                    routing.addFeature(WideEventFeature.create("test-component", out));
                    routing.get("/ok", (req, res) -> res.send("ok"));
                    routing.get("/err", (req, res) -> {
                        // Simulate what ConnectUnaryHandler.sendError does on a failed RPC.
                        WideEvents.connectCode(req, "not_found");
                        res.status(Status.NOT_FOUND_404).send("nope");
                    });
                    routing.get("/boom", (req, res) -> {
                        throw new IllegalStateException("kaboom");
                    });
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

    private void get(String path, String... headers) throws Exception {
        HttpRequest.Builder builder =
                HttpRequest.newBuilder().uri(URI.create("http://localhost:" + server.port() + path));
        for (int i = 0; i < headers.length; i += 2) {
            builder.header(headers[i], headers[i + 1]);
        }
        client.send(builder.GET().build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    /**
     * The filter emits in its completion path, which runs on the server thread
     * after the response is already on the wire — so the client returning can race
     * the emit. Poll briefly for the line rather than assuming it is there.
     */
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
    void emitsOneEventOnSuccessWithGeneratedTrace() throws Exception {
        get("/ok");
        WideEvent event = awaitSingleEvent();
        assertEquals(200, event.getStatus());
        assertEquals("GET", event.getHttpMethod());
        assertEquals("/ok", event.getPath());
        assertEquals("test-component", event.getComponent());
        assertNull(event.getConnectCode(), "no connect_code on success");
        assertNull(event.getError(), "no error on success");
        assertTrue(event.getDurationMs() >= 0, "duration is non-negative");
        assertTrue(event.getTraceId().matches("[0-9a-f]{32}"), "generated trace id");
        assertNull(event.getParentSpanId(), "no parent when no inbound traceparent");
        assertFalse(event.getTimestamp().isBlank(), "timestamp is set");
    }

    @Test
    void adoptsInboundTraceparent() throws Exception {
        get("/ok", "traceparent", TRACEPARENT);
        WideEvent event = awaitSingleEvent();
        assertEquals(TRACE_ID, event.getTraceId(), "inbound trace id is adopted");
        assertEquals(INBOUND_PARENT, event.getParentSpanId(), "inbound parent id is recorded");
        assertNotEquals(INBOUND_PARENT, event.getSpanId(), "a fresh span id is generated");
    }

    @Test
    void enrichesConnectCodeOnError() throws Exception {
        get("/err");
        WideEvent event = awaitSingleEvent();
        assertEquals(404, event.getStatus());
        assertEquals("not_found", event.getConnectCode(), "connect_code enrichment lands on the event");
    }

    @Test
    void emitsEventOnThrownException() throws Exception {
        get("/boom");
        WideEvent event = awaitSingleEvent();
        // Helidon routing converts the uncaught exception into a 500 before the
        // filter's completion path runs, so status is accurate and the event fires.
        assertEquals(500, event.getStatus(), "error path still emits with the final status");
    }
}
