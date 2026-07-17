package com.webuipoc.businesslogic;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.webuipoc.businesslogic.mapper.TodoMapperImpl;
import com.webuipoc.businesslogic.todo.TodoDb;
import com.webuipoc.businesslogic.todo.TodoGrpcBridge;
import com.webuipoc.businesslogic.todo.TodoRepository;
import com.webuipoc.businesslogic.todo.TodoService;
import io.avaje.validation.Validator;
import io.helidon.webserver.WebServer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class MainTest {

    @TempDir
    Path tempDir;

    /** Starts a server with the PRODUCTION routing (Main::routing) on an ephemeral port. */
    private WebServer startWiredServer(TodoDb db) {
        TodoGrpcBridge bridge = new TodoGrpcBridge(
                new TodoService(new TodoRepository(db)),
                new TodoMapperImpl(),
                Validator.builder().build());
        return WebServer.builder()
                .port(0)
                .routing(routing -> Main.routing(routing, bridge))
                .build()
                .start();
    }

    @Test
    void healthEndpointReturnsSameJsonShapeAsBunService() throws Exception {
        try (TodoDb db = new TodoDb(tempDir.resolve("todos.db").toString())) {
            WebServer server = startWiredServer(db);
            try (HttpClient client = HttpClient.newHttpClient()) {
                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create("http://localhost:" + server.port() + "/health"))
                        .GET()
                        .build();
                HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

                assertEquals(200, response.statusCode());
                assertEquals("{\"status\":\"ok\"}", response.body());
                assertEquals(
                        "application/json",
                        response.headers().firstValue("content-type").orElse(""));
            } finally {
                server.stop();
            }
        }
    }

    @Test
    void wiredRoutingServesTodoServiceOverConnectJson() throws Exception {
        try (TodoDb db = new TodoDb(tempDir.resolve("todos.db").toString())) {
            WebServer server = startWiredServer(db);
            try (HttpClient client = HttpClient.newHttpClient()) {
                String base = "http://localhost:" + server.port();

                // CreateTodo over Connect-unary JSON, through the real server.
                HttpResponse<String> created = client.send(
                        HttpRequest.newBuilder()
                                .uri(URI.create(base + "/todo.v1.TodoService/CreateTodo"))
                                .header("Content-Type", "application/json")
                                .POST(HttpRequest.BodyPublishers.ofString("{\"title\":\"wired through Main\"}"))
                                .build(),
                        HttpResponse.BodyHandlers.ofString());
                assertEquals(200, created.statusCode());
                assertTrue(
                        created.headers().firstValue("content-type").orElse("").startsWith("application/json"),
                        "content-type was: "
                                + created.headers().firstValue("content-type").orElse(""));
                assertTrue(created.body().contains("\"title\":\"wired through Main\""), "body was: " + created.body());

                // The created todo is visible via ListTodos (same DB instance).
                HttpResponse<String> listed = client.send(
                        HttpRequest.newBuilder()
                                .uri(URI.create(base + "/todo.v1.TodoService/ListTodos"))
                                .header("Content-Type", "application/json")
                                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                                .build(),
                        HttpResponse.BodyHandlers.ofString());
                assertEquals(200, listed.statusCode());
                assertTrue(listed.body().contains("\"title\":\"wired through Main\""), "body was: " + listed.body());
            } finally {
                server.stop();
            }
        }
    }

    @Test
    void uppercaseUuidPassesValidationAndMissesAtTheRepoLayer() throws Exception {
        // protovalidate's string.uuid rule is case-insensitive: an uppercase
        // UUID is NOT rejected as invalid_argument. Server-generated ids are
        // lowercase UUIDv7, so the lookup then misses with not_found from the
        // repository layer. This pins the boundary between the two layers.
        try (TodoDb db = new TodoDb(tempDir.resolve("todos.db").toString())) {
            WebServer server = startWiredServer(db);
            try (HttpClient client = HttpClient.newHttpClient()) {
                HttpResponse<String> response = client.send(
                        HttpRequest.newBuilder()
                                .uri(URI.create("http://localhost:" + server.port() + "/todo.v1.TodoService/GetTodo"))
                                .header("Content-Type", "application/json")
                                .POST(HttpRequest.BodyPublishers.ofString(
                                        "{\"id\":\"0197ABCD-EF12-7ABC-8DEF-0123456789AB\"}"))
                                .build(),
                        HttpResponse.BodyHandlers.ofString());

                assertEquals(404, response.statusCode());
                assertTrue(response.body().contains("\"code\":\"not_found\""), "body was: " + response.body());
            } finally {
                server.stop();
            }
        }
    }

    @Test
    void generatedGrpcStubsAndProtobufMessagesWork() {
        // Stubs generated by buf (protoc-gen-grpc-java) are on the compile path.
        assertEquals("todo.v1.TodoService", todo.v1.TodoServiceGrpc.SERVICE_NAME);
        assertEquals(
                5, todo.v1.TodoServiceGrpc.getServiceDescriptor().getMethods().size());

        // Editions-2023 gencode cooperates with the protobuf-java runtime,
        // including explicit field presence on UpdateTodoRequest.title.
        todo.v1.TodoOuterClass.UpdateTodoRequest request = todo.v1.TodoOuterClass.UpdateTodoRequest.newBuilder()
                .setId("todo-1")
                .setTitle("renamed")
                .build();
        assertTrue(request.hasTitle());
        assertEquals("renamed", request.getTitle());
    }
}
