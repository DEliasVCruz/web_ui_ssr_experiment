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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * End-to-end (through the real Connect adapter + production routing) proof that
 * the domain business rule closes the wire gap: protovalidate's
 * {@code string.min_len = 1} admits a single space, but the avaje-validator rule
 * in the bridge rejects a blank-after-trim title as Connect
 * {@code invalid_argument} (HTTP 400), for both CreateTodo and UpdateTodo.
 */
class TodoBusinessValidationTest {

    @TempDir
    Path tempDir;

    private static final Pattern ID = Pattern.compile("\"id\":\"([^\"]+)\"");

    private WebServer startServer(TodoDb db) {
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

    private static HttpResponse<String> post(HttpClient client, String base, String method, String json)
            throws Exception {
        return client.send(
                HttpRequest.newBuilder()
                        .uri(URI.create(base + "/todo.v1.TodoService/" + method))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(json))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void whitespaceOnlyTitleRejectedOnCreate() throws Exception {
        try (TodoDb db = new TodoDb(tempDir.resolve("todos.db").toString())) {
            WebServer server = startServer(db);
            try (HttpClient client = HttpClient.newHttpClient()) {
                // A single space passes protovalidate (min_len 1) but is blank.
                HttpResponse<String> response =
                        post(client, "http://localhost:" + server.port(), "CreateTodo", "{\"title\":\" \"}");
                assertEquals(400, response.statusCode(), "body: " + response.body());
                assertTrue(response.body().contains("\"code\":\"invalid_argument\""), "body: " + response.body());
                assertTrue(response.body().contains("title"), "body should name the field: " + response.body());
            } finally {
                server.stop();
            }
        }
    }

    @Test
    void whitespaceOnlyTitleRejectedOnUpdate() throws Exception {
        try (TodoDb db = new TodoDb(tempDir.resolve("todos.db").toString())) {
            WebServer server = startServer(db);
            try (HttpClient client = HttpClient.newHttpClient()) {
                String base = "http://localhost:" + server.port();

                // Create a valid todo, then grab its (UUIDv7, so protovalidate-valid) id.
                HttpResponse<String> created = post(client, base, "CreateTodo", "{\"title\":\"real title\"}");
                assertEquals(200, created.statusCode(), "body: " + created.body());
                Matcher m = ID.matcher(created.body());
                assertTrue(m.find(), "no id in create response: " + created.body());
                String id = m.group(1);

                // Updating that todo with a single-space title must be rejected.
                HttpResponse<String> response =
                        post(client, base, "UpdateTodo", "{\"id\":\"" + id + "\",\"title\":\" \"}");
                assertEquals(400, response.statusCode(), "body: " + response.body());
                assertTrue(response.body().contains("\"code\":\"invalid_argument\""), "body: " + response.body());
                assertTrue(response.body().contains("title"), "body should name the field: " + response.body());
            } finally {
                server.stop();
            }
        }
    }
}
