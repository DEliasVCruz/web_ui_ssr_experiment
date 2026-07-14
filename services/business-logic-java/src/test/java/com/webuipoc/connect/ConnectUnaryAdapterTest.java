package com.webuipoc.connect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.protobuf.Struct;
import com.google.protobuf.util.JsonFormat;
import io.helidon.webserver.WebServer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Locale;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import todo.v1.TodoOuterClass;

/**
 * Integration tests for the Connect-unary adapter: a real Helidon WebServer on
 * an ephemeral port serving {@link StubTodoService} through
 * {@link ConnectUnaryFeature}, exercised with a plain HTTP client so every
 * byte on the wire is asserted against the Connect protocol spec.
 */
class ConnectUnaryAdapterTest {

    private static final String GET_TODO = "/todo.v1.TodoService/GetTodo";
    private static final String CREATE_TODO = "/todo.v1.TodoService/CreateTodo";
    private static final String UPDATE_TODO = "/todo.v1.TodoService/UpdateTodo";
    /** Any syntactically valid UUID: the stub echoes it back as the todo id. */
    private static final String ECHO_ID = "8b3e1a1e-6f2a-4b57-9f3e-2d4c5a6b7c8d";
    private static final int TITLE_MAX_LEN = 100;

    private static WebServer server;
    private static HttpClient client;

    @BeforeAll
    static void startServer() {
        server = WebServer.builder()
                .port(0)
                .routing(routing -> routing.addFeature(ConnectUnaryFeature.create(new StubTodoService())))
                .build()
                .start();
        client = HttpClient.newHttpClient();
    }

    @AfterAll
    static void stopServer() {
        client.close();
        server.stop();
    }

    private static HttpRequest.Builder request(String path) {
        return HttpRequest.newBuilder().uri(URI.create("http://localhost:" + server.port() + path));
    }

    private static HttpResponse<byte[]> postProto(String path, com.google.protobuf.Message message)
            throws Exception {
        HttpRequest request = request(path)
                .header("Content-Type", "application/proto")
                .header("Connect-Protocol-Version", "1")
                .POST(HttpRequest.BodyPublishers.ofByteArray(message.toByteArray()))
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofByteArray());
    }

    private static Struct parseJson(byte[] body) throws Exception {
        Struct.Builder struct = Struct.newBuilder();
        JsonFormat.parser().merge(new String(body, java.nio.charset.StandardCharsets.UTF_8), struct);
        return struct.build();
    }

    private static void assertConnectError(HttpResponse<byte[]> response, int expectedStatus, String expectedCode)
            throws Exception {
        assertEquals(expectedStatus, response.statusCode());
        // Spec: error responses are always application/json, whatever the request codec.
        assertEquals("application/json", response.headers().firstValue("content-type").orElse(""));
        Struct body = parseJson(response.body());
        assertEquals(expectedCode, body.getFieldsOrThrow("code").getStringValue());
    }

    @Test
    void happyPathBinary() throws Exception {
        TodoOuterClass.GetTodoRequest request = TodoOuterClass.GetTodoRequest.newBuilder()
                .setId(ECHO_ID)
                .build();
        HttpResponse<byte[]> response = postProto(GET_TODO, request);

        assertEquals(200, response.statusCode());
        assertEquals("application/proto", response.headers().firstValue("content-type").orElse(""));
        // The body is the bare serialized message — no envelope framing.
        TodoOuterClass.GetTodoResponse parsed = TodoOuterClass.GetTodoResponse.parseFrom(response.body());
        assertEquals(ECHO_ID, parsed.getTodo().getId());
        assertEquals("stub-todo", parsed.getTodo().getTitle());
    }

    @Test
    void happyPathJson() throws Exception {
        HttpRequest request = request(GET_TODO)
                .header("Content-Type", "application/json")
                // no connect-protocol-version header: it must not be required
                .POST(HttpRequest.BodyPublishers.ofString("{\"id\":\"" + ECHO_ID + "\"}"))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertEquals(200, response.statusCode());
        // The response codec mirrors the request codec.
        assertEquals("application/json", response.headers().firstValue("content-type").orElse(""));
        Struct body = parseJson(response.body());
        assertEquals(ECHO_ID, body.getFieldsOrThrow("todo").getStructValue()
                .getFieldsOrThrow("id").getStringValue());
    }

    @Test
    void notFoundErrorMapsTo404WithJsonBody() throws Exception {
        TodoOuterClass.GetTodoRequest request = TodoOuterClass.GetTodoRequest.newBuilder()
                .setId(StubTodoService.MISSING_ID)
                .build();
        HttpResponse<byte[]> response = postProto(GET_TODO, request);

        assertConnectError(response, 404, "not_found");
        Struct body = parseJson(response.body());
        assertEquals("todo \"" + StubTodoService.MISSING_ID + "\" not found",
                body.getFieldsOrThrow("message").getStringValue());
    }

    /**
     * End-to-end check of the full spec table: the stub raises every gRPC
     * status code and the wire shows the exact Connect code string and HTTP
     * status from the specification.
     */
    @Test
    void fullSpecErrorCodeTable() throws Exception {
        record Row(String grpcCode, String connectCode, int httpStatus) {
        }
        // Transcribed from https://connectrpc.com/docs/protocol/ ("Error Codes").
        List<Row> table = List.of(
                new Row("CANCELLED", "canceled", 499),
                new Row("UNKNOWN", "unknown", 500),
                new Row("INVALID_ARGUMENT", "invalid_argument", 400),
                new Row("DEADLINE_EXCEEDED", "deadline_exceeded", 504),
                new Row("NOT_FOUND", "not_found", 404),
                new Row("ALREADY_EXISTS", "already_exists", 409),
                new Row("PERMISSION_DENIED", "permission_denied", 403),
                new Row("RESOURCE_EXHAUSTED", "resource_exhausted", 429),
                new Row("FAILED_PRECONDITION", "failed_precondition", 400),
                new Row("ABORTED", "aborted", 409),
                new Row("OUT_OF_RANGE", "out_of_range", 400),
                new Row("UNIMPLEMENTED", "unimplemented", 501),
                new Row("INTERNAL", "internal", 500),
                new Row("UNAVAILABLE", "unavailable", 503),
                new Row("DATA_LOSS", "data_loss", 500),
                new Row("UNAUTHENTICATED", "unauthenticated", 401));
        assertEquals(16, table.size());

        for (Row row : table) {
            TodoOuterClass.GetTodoRequest request = TodoOuterClass.GetTodoRequest.newBuilder()
                    .setId(StubTodoService.errorId(io.grpc.Status.Code.valueOf(row.grpcCode())))
                    .build();
            HttpResponse<byte[]> response = postProto(GET_TODO, request);
            assertConnectError(response, row.httpStatus(), row.connectCode());
        }
    }

    @Test
    void statusRuntimeExceptionThrownSynchronouslyIsMapped() throws Exception {
        TodoOuterClass.GetTodoRequest request = TodoOuterClass.GetTodoRequest.newBuilder()
                .setId(StubTodoService.THROW_ID)
                .build();
        HttpResponse<byte[]> response = postProto(GET_TODO, request);

        assertConnectError(response, 403, "permission_denied");
    }

    @Test
    void unknownMethodRespondsUnimplemented() throws Exception {
        HttpRequest request = request("/todo.v1.TodoService/NoSuchMethod")
                .header("Content-Type", "application/proto")
                .POST(HttpRequest.BodyPublishers.ofByteArray(new byte[0]))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        // 404 on the wire (spec's HTTP-to-Connect table infers unimplemented
        // from it); the body states the Connect code explicitly.
        assertConnectError(response, 404, "unimplemented");
    }

    @Test
    void unknownServiceRespondsNotFound() throws Exception {
        HttpRequest request = request("/nope.v1.NopeService/Nope")
                .header("Content-Type", "application/proto")
                .POST(HttpRequest.BodyPublishers.ofByteArray(new byte[0]))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        // Unregistered service: plain 404 from routing; per spec clients infer unimplemented.
        assertEquals(404, response.statusCode());
    }

    @Test
    void unsupportedContentTypeRespondsHttp415() throws Exception {
        HttpRequest request = request(GET_TODO)
                .header("Content-Type", "text/plain")
                .POST(HttpRequest.BodyPublishers.ofString("id=abc"))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertEquals(415, response.statusCode());
    }

    @Test
    void unsupportedContentEncodingRespondsUnimplemented() throws Exception {
        HttpRequest request = request(GET_TODO)
                .header("Content-Type", "application/proto")
                .header("Content-Encoding", "gzip")
                .POST(HttpRequest.BodyPublishers.ofByteArray(new byte[0]))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertConnectError(response, 501, "unimplemented");
        Struct body = parseJson(response.body());
        assertTrue(body.getFieldsOrThrow("message").getStringValue().contains("identity"),
                "message should list the supported encodings");
    }

    @Test
    void unsupportedProtocolVersionRespondsInvalidArgument() throws Exception {
        HttpRequest request = request(GET_TODO)
                .header("Content-Type", "application/proto")
                .header("Connect-Protocol-Version", "2")
                .POST(HttpRequest.BodyPublishers.ofByteArray(new byte[0]))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertConnectError(response, 400, "invalid_argument");
    }

    @Test
    void malformedRequestBodyRespondsInvalidArgument() throws Exception {
        HttpRequest request = request(GET_TODO)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{not json"))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertConnectError(response, 400, "invalid_argument");
    }

    @Test
    void timeoutIsHonoredForSlowAsyncHandlers() throws Exception {
        HttpRequest request = request(GET_TODO)
                .header("Content-Type", "application/proto")
                .header("Connect-Timeout-Ms", "50")
                .POST(HttpRequest.BodyPublishers.ofByteArray(
                        TodoOuterClass.GetTodoRequest.newBuilder().setId(StubTodoService.SLOW_ID).build()
                                .toByteArray()))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertConnectError(response, 504, "deadline_exceeded");
    }

    @Test
    void malformedTimeoutRespondsInvalidArgument() throws Exception {
        HttpRequest request = request(GET_TODO)
                .header("Content-Type", "application/proto")
                .header("Connect-Timeout-Ms", "not-a-number")
                .POST(HttpRequest.BodyPublishers.ofByteArray(new byte[0]))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertConnectError(response, 400, "invalid_argument");
    }

    @Test
    void preflightRequestGetsConnectCorsHeaders() throws Exception {
        HttpRequest request = request(GET_TODO)
                .header("Origin", "http://localhost:3000")
                .header("Access-Control-Request-Method", "POST")
                .header("Access-Control-Request-Headers", "content-type,connect-protocol-version")
                .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertEquals(204, response.statusCode());
        assertEquals("*", response.headers().firstValue("access-control-allow-origin").orElse(""));

        String allowMethods = response.headers().firstValue("access-control-allow-methods").orElse("");
        for (String method : ConnectCors.ALLOWED_METHODS) {
            assertTrue(allowMethods.contains(method), "allow-methods should contain " + method);
        }

        String allowHeaders = response.headers().firstValue("access-control-allow-headers").orElse("")
                .toLowerCase(Locale.ROOT);
        for (String header : ConnectCors.ALLOWED_HEADERS) {
            assertTrue(allowHeaders.contains(header.toLowerCase(Locale.ROOT)),
                    "allow-headers should contain " + header);
        }
    }

    @Test
    void actualResponsesCarryCorsHeaders() throws Exception {
        TodoOuterClass.GetTodoRequest request = TodoOuterClass.GetTodoRequest.newBuilder()
                .setId(ECHO_ID)
                .build();
        HttpResponse<byte[]> response = postProto(GET_TODO, request);

        assertEquals("*", response.headers().firstValue("access-control-allow-origin").orElse(""));
        String exposed = response.headers().firstValue("access-control-expose-headers").orElse("")
                .toLowerCase(Locale.ROOT);
        for (String header : ConnectCors.EXPOSED_HEADERS) {
            assertTrue(exposed.contains(header.toLowerCase(Locale.ROOT)),
                    "expose-headers should contain " + header);
        }
    }

    @Test
    void emptyRequestMessageWorks() throws Exception {
        HttpResponse<byte[]> response = postProto("/todo.v1.TodoService/ListTodos",
                TodoOuterClass.ListTodosRequest.getDefaultInstance());

        assertEquals(200, response.statusCode());
        TodoOuterClass.ListTodosResponse parsed = TodoOuterClass.ListTodosResponse.parseFrom(response.body());
        assertEquals(2, parsed.getTodosCount());
        assertNotNull(parsed.getTodos(0).getCreatedAt());
    }

    // ---- protovalidate enforcement (buf.validate.* constraints in todo.proto) ----

    @Test
    void createTodoWithEmptyTitleIsRejectedBinary() throws Exception {
        TodoOuterClass.CreateTodoRequest request = TodoOuterClass.CreateTodoRequest.newBuilder()
                .setTitle("")
                .build();
        HttpResponse<byte[]> response = postProto(CREATE_TODO, request);

        assertConnectError(response, 400, "invalid_argument");
        String message = parseJson(response.body()).getFieldsOrThrow("message").getStringValue();
        assertTrue(message.contains("title"), "message should name the violated field: " + message);
    }

    @Test
    void createTodoWithEmptyTitleIsRejectedJson() throws Exception {
        HttpRequest request = request(CREATE_TODO)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{\"title\":\"\"}"))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        // Violations map to invalid_argument with the (always-JSON) error body,
        // for the JSON request codec too.
        assertConnectError(response, 400, "invalid_argument");
        String message = parseJson(response.body()).getFieldsOrThrow("message").getStringValue();
        assertTrue(message.contains("title"), "message should name the violated field: " + message);
    }

    @Test
    void createTodoWithOverlongTitleIsRejected() throws Exception {
        TodoOuterClass.CreateTodoRequest request = TodoOuterClass.CreateTodoRequest.newBuilder()
                .setTitle("x".repeat(TITLE_MAX_LEN + 1))
                .build();
        HttpResponse<byte[]> response = postProto(CREATE_TODO, request);

        assertConnectError(response, 400, "invalid_argument");
        String message = parseJson(response.body()).getFieldsOrThrow("message").getStringValue();
        assertTrue(message.contains("title"), "message should name the violated field: " + message);
    }

    @Test
    void createTodoWithMaxLengthTitleIsAccepted() throws Exception {
        String title = "x".repeat(TITLE_MAX_LEN);
        TodoOuterClass.CreateTodoRequest request = TodoOuterClass.CreateTodoRequest.newBuilder()
                .setTitle(title)
                .build();
        HttpResponse<byte[]> response = postProto(CREATE_TODO, request);

        assertEquals(200, response.statusCode());
        TodoOuterClass.CreateTodoResponse parsed = TodoOuterClass.CreateTodoResponse.parseFrom(response.body());
        assertEquals(title, parsed.getTodo().getTitle());
    }

    @Test
    void updateTodoWithoutTitleSetIsAccepted() throws Exception {
        // UpdateTodoRequest.title has explicit presence: the min_len rule must
        // only apply when the field is set.
        TodoOuterClass.UpdateTodoRequest request = TodoOuterClass.UpdateTodoRequest.newBuilder()
                .setId(ECHO_ID)
                .setCompleted(true)
                .build();
        HttpResponse<byte[]> response = postProto(UPDATE_TODO, request);

        assertEquals(200, response.statusCode());
        TodoOuterClass.UpdateTodoResponse parsed = TodoOuterClass.UpdateTodoResponse.parseFrom(response.body());
        assertEquals("unchanged", parsed.getTodo().getTitle());
    }

    @Test
    void updateTodoWithEmptyTitleSetIsRejected() throws Exception {
        TodoOuterClass.UpdateTodoRequest request = TodoOuterClass.UpdateTodoRequest.newBuilder()
                .setId(ECHO_ID)
                .setTitle("")
                .build();
        HttpResponse<byte[]> response = postProto(UPDATE_TODO, request);

        assertConnectError(response, 400, "invalid_argument");
        String message = parseJson(response.body()).getFieldsOrThrow("message").getStringValue();
        assertTrue(message.contains("title"), "message should name the violated field: " + message);
    }

    @Test
    void getTodoWithNonUuidIdIsRejected() throws Exception {
        TodoOuterClass.GetTodoRequest request = TodoOuterClass.GetTodoRequest.newBuilder()
                .setId("not-a-uuid")
                .build();
        HttpResponse<byte[]> response = postProto(GET_TODO, request);

        assertConnectError(response, 400, "invalid_argument");
        String message = parseJson(response.body()).getFieldsOrThrow("message").getStringValue();
        assertTrue(message.contains("id"), "message should name the violated field: " + message);
    }
}
