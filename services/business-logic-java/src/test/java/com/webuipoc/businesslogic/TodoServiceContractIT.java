package com.webuipoc.businesslogic;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.protobuf.Message;
import com.google.protobuf.Struct;
import com.google.protobuf.util.JsonFormat;
import com.webuipoc.businesslogic.todo.PostgresSupport;
import io.helidon.webserver.WebServer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import todo.v1.TodoOuterClass;

/**
 * End-to-end contract suite for the business-logic-java service — the JUnit 5 +
 * Testcontainers replacement for the retired Bun {@code scripts/connect-contract-test.ts}.
 *
 * <p>Unlike {@code ConnectUnaryAdapterTest} (which mounts the service-agnostic
 * adapter over the in-memory {@code StubTodoService}), this boots the <em>real</em>
 * service exactly as production does: {@link Main#start()} builds the full
 * avaje-inject graph — HikariCP pool &rarr; Flyway-migrated schema &rarr; jOOQ
 * {@code TodoRepository} &rarr; {@code TodoService} &rarr; {@code TodoGrpcBridge}
 * &rarr; {@code ConnectUnaryFeature} — on a Helidon {@code WebServer} bound to an
 * ephemeral port, backed by a real {@code postgres:17-alpine} started via
 * Testcontainers (the shared {@link PostgresSupport} singleton container). Every
 * assertion is made over raw {@link HttpClient} bytes/headers/status codes: the
 * rawness is the point — these pin the Connect wire contract end to end.
 *
 * <p><b>Config seam.</b> The service reads its port and database coordinates from
 * avaje-config, whose {@code application.yaml} exposes the public env-var contract
 * ({@code ${PORT:3001}}, {@code ${DATABASE_URL:...}}, ...). {@link #bootService()}
 * sets those as system properties (avaje-config consults system properties ahead
 * of env vars — proven in {@code ServiceConfigTest}) pointing {@code PORT=0} at an
 * OS-assigned port and the DB coordinates at the Testcontainers container, then
 * boots through the identical {@link Main#start()} path — no test-only wiring.
 *
 * <p><b>Isolation.</b> One container + one booted server per class. Each test
 * starts from an empty {@code todos} table ({@link PostgresSupport#reset()} in
 * {@link BeforeEach}) and seeds only the rows it needs, so tests are order- and
 * data-independent. Tests within the class run sequentially (they share the one
 * database, so a concurrent {@code TRUNCATE} would race); the suite as a whole is
 * parallel-safe across builds because it owns an ephemeral container and an
 * ephemeral port rather than the retired harness's fixed {@code :3911}.
 *
 * <h2>1:1 map of the 18 retired TS contract checks &rarr; test methods</h2>
 *
 * <pre>
 *  #  retired connect-contract-test.ts check          port
 *  1  getTodo round-trip                              getTodoRoundTripsOverConnectGetBinary
 *  2  getTodo issues an HTTP GET                       getTodoRoundTripsOverConnectGetBinary (GET accepted on the safe method)
 *  3  getTodo GET carries binary Connect query params  getTodoRoundTripsOverConnectGetBinary (connect=v1&amp;encoding=proto&amp;base64=1&amp;message=)
 *  4  getTodo timestamps decode                        getTodoRoundTripsOverConnectGetBinary (createdAt present)
 *  5  createTodo round-trip                            createTodoRoundTripsOverBinaryPost
 *  6  createTodo issues an HTTP POST                   createTodoRoundTripsOverBinaryPost (GET -> 405 Allow: POST)
 *  7  listTodos round-trip                             listTodosRoundTripsOverConnectGet
 *  8  listTodos issues an HTTP GET                     listTodosRoundTripsOverConnectGet (GET accepted on the safe method)
 *  9  listTodos GET carries an (empty) message param   listTodosRoundTripsOverConnectGet (message= empty)
 * 10  getTodo NOT_FOUND surfaces as ConnectError       getTodoNotFoundMapsToConnectError (404 not_found)
 * 11  NOT_FOUND message is preserved                   getTodoNotFoundMapsToConnectError ("todo not found")
 * 12  createTodo empty title rejected                  createTodoWithEmptyTitleIsRejected
 * 13  createTodo 101-char title rejected               createTodoWithOverlongTitleIsRejected
 * 14  createTodo 100-char title accepted               createTodoWithMaxLengthTitleIsAccepted
 * 15  getTodo non-UUID id rejected                     getTodoWithNonUuidIdIsRejected
 * 16  updateTodo without title passes validation       updateTodoWithoutTitleSetIsAccepted
 * 17  updateTodo issues an HTTP POST                   updateTodoWithoutTitleSetIsAccepted (GET -> 405 Allow: POST)
 * 18  updateTodo with empty title rejected             updateTodoWithEmptyTitleSetIsRejected
 * </pre>
 *
 * <p>Complementary full-stack surfaces the TS script did not cover (the adapter's
 * JSON debug codec and unsupported-content-type handling are pinned in detail by
 * {@code ConnectUnaryAdapterTest}; these two re-assert them through the real
 * database-backed service): {@link #jsonDebugCodecRoundTripsThroughRealService}
 * and {@link #unsupportedContentTypeIsRejectedWithHttp415}.
 */
class TodoServiceContractIT {

    private static final String GET_TODO = "/todo.v1.TodoService/GetTodo";
    private static final String CREATE_TODO = "/todo.v1.TodoService/CreateTodo";
    private static final String UPDATE_TODO = "/todo.v1.TodoService/UpdateTodo";
    private static final String LIST_TODOS = "/todo.v1.TodoService/ListTodos";

    private static final int TITLE_MAX_LEN = 100;
    private static final int DETAILS_MAX_LEN = 1000;
    /** The exact message the domain NotFoundException carries (TodoService.NOT_FOUND_MESSAGE). */
    private static final String NOT_FOUND_MESSAGE = "todo not found";

    private static WebServer server;
    private static HttpClient client;

    @BeforeAll
    static void bootService() {
        // Touch the shared container first so its coordinates are known, then feed
        // them (plus an ephemeral port) through the public env-var contract as
        // system properties. avaje-config resolves application.yaml's
        // ${PORT}/${DATABASE_URL}/... from system properties ahead of env vars.
        PostgresSupport.reset();
        System.setProperty("PORT", "0");
        System.setProperty("DATABASE_URL", PostgresSupport.dataSource().getJdbcUrl());
        System.setProperty("DATABASE_USERNAME", PostgresSupport.dataSource().getUsername());
        System.setProperty("DATABASE_PASSWORD", PostgresSupport.dataSource().getPassword());
        // Boot the real service through the production composition seam. The
        // avaje shutdownHook(true) scope closes the bean graph (and its pool) on
        // JVM exit; we keep only the WebServer handle to read the port and stop it.
        server = Main.start();
        client = HttpClient.newHttpClient();
    }

    @AfterAll
    static void stopService() {
        if (client != null) {
            client.close();
        }
        if (server != null) {
            server.stop();
        }
        System.clearProperty("PORT");
        System.clearProperty("DATABASE_URL");
        System.clearProperty("DATABASE_USERNAME");
        System.clearProperty("DATABASE_PASSWORD");
    }

    @BeforeEach
    void reset() {
        PostgresSupport.reset();
    }

    // ---- checks 1-4: getTodo round-trips over a binary Connect GET ----

    @Test
    void getTodoRoundTripsOverConnectGetBinary() throws Exception {
        // Seed a real row through the real create path, then read it back the way
        // connect-es reads an idempotent (NO_SIDE_EFFECTS) RPC: a Connect GET
        // carrying the binary request as base64url in the message parameter.
        TodoOuterClass.Todo seeded = createTodo("round-trip-target");

        TodoOuterClass.GetTodoRequest request =
                TodoOuterClass.GetTodoRequest.newBuilder().setId(seeded.getId()).build();
        HttpResponse<byte[]> response =
                get(GET_TODO + "?connect=v1&encoding=proto&base64=1&message=" + base64Url(request.toByteArray()));

        // check 2: GET is accepted on the safe method (a non-safe method 405s below).
        assertEquals(200, response.statusCode());
        // check 3: the binary Connect GET query params (encoding=proto) drove a proto response.
        assertEquals(
                "application/proto",
                response.headers().firstValue("content-type").orElse(""));
        TodoOuterClass.GetTodoResponse parsed = TodoOuterClass.GetTodoResponse.parseFrom(response.body());
        // check 1: the round-tripped todo matches what was created.
        assertEquals(seeded.getId(), parsed.getTodo().getId());
        assertEquals("round-trip-target", parsed.getTodo().getTitle());
        // check 4: timestamps decode (the DDL now() default was persisted and read back).
        assertTrue(parsed.getTodo().hasCreatedAt(), "createdAt must be present on the decoded todo");
    }

    // ---- checks 5-6: createTodo round-trips over binary POST; GET is rejected ----

    @Test
    void createTodoRoundTripsOverBinaryPost() throws Exception {
        // check 5: a binary POST create returns the persisted todo (server-generated id, echoed title).
        TodoOuterClass.CreateTodoRequest request = TodoOuterClass.CreateTodoRequest.newBuilder()
                .setTitle("from-connect-es")
                .build();
        HttpResponse<byte[]> response = postProto(CREATE_TODO, request);

        assertEquals(200, response.statusCode());
        TodoOuterClass.CreateTodoResponse parsed = TodoOuterClass.CreateTodoResponse.parseFrom(response.body());
        assertEquals("from-connect-es", parsed.getTodo().getTitle());
        assertFalse(parsed.getTodo().getId().isEmpty(), "create must assign a server-generated id");

        // check 6: createTodo is a mutation — the adapter rejects GET (405, Allow: POST),
        // which is exactly why connect-es keeps it on POST.
        HttpResponse<byte[]> viaGet = get(CREATE_TODO + "?connect=v1&encoding=proto&base64=1&message=");
        assertEquals(405, viaGet.statusCode());
        assertEquals("POST", viaGet.headers().firstValue("allow").orElse(""));
    }

    // ---- checks 7-9: listTodos round-trips over a Connect GET with an empty message ----

    @Test
    void listTodosRoundTripsOverConnectGet() throws Exception {
        createTodo("first");
        createTodo("second");

        // ListTodosRequest is empty: connect-es sends message= (empty). check 8: GET
        // accepted; check 9: the empty message parameter decodes to an empty request.
        HttpResponse<byte[]> response = get(LIST_TODOS + "?connect=v1&encoding=proto&base64=1&message=");

        assertEquals(200, response.statusCode());
        TodoOuterClass.ListTodosResponse parsed = TodoOuterClass.ListTodosResponse.parseFrom(response.body());
        // check 7: both seeded todos come back.
        assertEquals(2, parsed.getTodosCount());
    }

    // ---- checks 10-11: NOT_FOUND surfaces as a Connect error envelope ----

    @Test
    void getTodoNotFoundMapsToConnectError() throws Exception {
        // A syntactically valid UUID that is not in the table: passes protovalidate,
        // misses at the repository, and the service throws NotFoundException.
        String missingId = UUID.randomUUID().toString();
        TodoOuterClass.GetTodoRequest request =
                TodoOuterClass.GetTodoRequest.newBuilder().setId(missingId).build();
        HttpResponse<byte[]> response =
                get(GET_TODO + "?connect=v1&encoding=proto&base64=1&message=" + base64Url(request.toByteArray()));

        // check 10: 404 with the not_found Connect code in the always-JSON error envelope.
        assertConnectError(response, 404, "not_found");
        // check 11: the domain message is preserved on the wire.
        assertEquals(
                NOT_FOUND_MESSAGE,
                parseJson(response.body()).getFieldsOrThrow("message").getStringValue());
    }

    // ---- checks 12-15, 18: protovalidate enforcement over the real service ----

    @Test
    void createTodoWithEmptyTitleIsRejected() throws Exception {
        // check 12
        HttpResponse<byte[]> response = postProto(
                CREATE_TODO,
                TodoOuterClass.CreateTodoRequest.newBuilder().setTitle("").build());
        assertInvalidArgumentNaming(response, "title");
    }

    @Test
    void createTodoWithOverlongTitleIsRejected() throws Exception {
        // check 13
        HttpResponse<byte[]> response = postProto(
                CREATE_TODO,
                TodoOuterClass.CreateTodoRequest.newBuilder()
                        .setTitle("x".repeat(TITLE_MAX_LEN + 1))
                        .build());
        assertInvalidArgumentNaming(response, "title");
    }

    @Test
    void createTodoWithMaxLengthTitleIsAccepted() throws Exception {
        // check 14: the 100-char boundary is accepted and persisted.
        String title = "y".repeat(TITLE_MAX_LEN);
        HttpResponse<byte[]> response = postProto(
                CREATE_TODO,
                TodoOuterClass.CreateTodoRequest.newBuilder().setTitle(title).build());

        assertEquals(200, response.statusCode());
        TodoOuterClass.CreateTodoResponse parsed = TodoOuterClass.CreateTodoResponse.parseFrom(response.body());
        assertEquals(title, parsed.getTodo().getTitle());
    }

    @Test
    void getTodoWithNonUuidIdIsRejected() throws Exception {
        // check 15
        HttpResponse<byte[]> response = postProto(
                GET_TODO,
                TodoOuterClass.GetTodoRequest.newBuilder().setId("not-a-uuid").build());
        assertInvalidArgumentNaming(response, "id");
    }

    // ---- checks 16-17: updateTodo without a title passes validation; GET is rejected ----

    @Test
    void updateTodoWithoutTitleSetIsAccepted() throws Exception {
        TodoOuterClass.Todo seeded = createTodo("keep-me");

        // UpdateTodoRequest.title has explicit presence: the min_len rule applies
        // only when set, so an update that only flips completed must validate and
        // leave the title untouched.
        TodoOuterClass.UpdateTodoRequest request = TodoOuterClass.UpdateTodoRequest.newBuilder()
                .setId(seeded.getId())
                .setCompleted(true)
                .build();
        HttpResponse<byte[]> response = postProto(UPDATE_TODO, request);

        // check 16
        assertEquals(200, response.statusCode());
        TodoOuterClass.UpdateTodoResponse parsed = TodoOuterClass.UpdateTodoResponse.parseFrom(response.body());
        assertEquals("keep-me", parsed.getTodo().getTitle());
        assertTrue(parsed.getTodo().getCompleted(), "completed should have been flipped to true");

        // check 17: updateTodo is a mutation — GET is rejected (405, Allow: POST).
        HttpResponse<byte[]> viaGet = get(UPDATE_TODO + "?connect=v1&encoding=proto&base64=1&message=");
        assertEquals(405, viaGet.statusCode());
        assertEquals("POST", viaGet.headers().firstValue("allow").orElse(""));
    }

    @Test
    void updateTodoWithEmptyTitleSetIsRejected() throws Exception {
        // check 18: an explicitly-set empty title violates min_len.
        TodoOuterClass.Todo seeded = createTodo("keep-me");
        HttpResponse<byte[]> response = postProto(
                UPDATE_TODO,
                TodoOuterClass.UpdateTodoRequest.newBuilder()
                        .setId(seeded.getId())
                        .setTitle("")
                        .build());
        assertInvalidArgumentNaming(response, "title");
    }

    // ---- details field: round-trip, partial-update semantics, and validation ----

    @Test
    void createWithDetailsRoundTripsOverBinaryPost() throws Exception {
        // A binary POST create carrying details returns them on the persisted todo.
        TodoOuterClass.CreateTodoRequest request = TodoOuterClass.CreateTodoRequest.newBuilder()
                .setTitle("with-details")
                .setDetails("remember the milk")
                .build();
        HttpResponse<byte[]> response = postProto(CREATE_TODO, request);

        assertEquals(200, response.statusCode());
        TodoOuterClass.Todo todo =
                TodoOuterClass.CreateTodoResponse.parseFrom(response.body()).getTodo();
        assertTrue(todo.hasDetails(), "details provided on create must be set on the wire");
        assertEquals("remember the milk", todo.getDetails());
    }

    @Test
    void createWithoutDetailsLeavesDetailsUnsetOnTheWire() throws Exception {
        // Omitting details persists NULL, so the read-back todo reports it unset.
        TodoOuterClass.Todo created = createTodo("no-details");
        assertFalse(created.hasDetails(), "details omitted on create must be unset on the wire");
    }

    @Test
    void updateDetailsPartialSemanticsOverTheWire() throws Exception {
        // Seed with details, then a details-only update must overwrite the details
        // while leaving the title untouched (presence-based partial update).
        TodoOuterClass.CreateTodoRequest seed = TodoOuterClass.CreateTodoRequest.newBuilder()
                .setTitle("keep-title")
                .setDetails("old-notes")
                .build();
        TodoOuterClass.Todo created = TodoOuterClass.CreateTodoResponse.parseFrom(
                        postProto(CREATE_TODO, seed).body())
                .getTodo();

        HttpResponse<byte[]> response = postProto(
                UPDATE_TODO,
                TodoOuterClass.UpdateTodoRequest.newBuilder()
                        .setId(created.getId())
                        .setDetails("new-notes")
                        .build());
        assertEquals(200, response.statusCode());
        TodoOuterClass.Todo updated =
                TodoOuterClass.UpdateTodoResponse.parseFrom(response.body()).getTodo();
        assertEquals("new-notes", updated.getDetails(), "details-only update must overwrite the details");
        assertEquals("keep-title", updated.getTitle(), "details-only update must preserve the title");

        // And an update that omits details must leave the (new) details untouched.
        HttpResponse<byte[]> keep = postProto(
                UPDATE_TODO,
                TodoOuterClass.UpdateTodoRequest.newBuilder()
                        .setId(created.getId())
                        .setCompleted(true)
                        .build());
        TodoOuterClass.Todo kept =
                TodoOuterClass.UpdateTodoResponse.parseFrom(keep.body()).getTodo();
        assertEquals("new-notes", kept.getDetails(), "update omitting details must preserve them");
    }

    @Test
    void createWithMaxLengthDetailsIsAccepted() throws Exception {
        // The 1000-char boundary is accepted and persisted.
        String details = "d".repeat(DETAILS_MAX_LEN);
        HttpResponse<byte[]> response = postProto(
                CREATE_TODO,
                TodoOuterClass.CreateTodoRequest.newBuilder()
                        .setTitle("boundary")
                        .setDetails(details)
                        .build());

        assertEquals(200, response.statusCode());
        TodoOuterClass.Todo todo =
                TodoOuterClass.CreateTodoResponse.parseFrom(response.body()).getTodo();
        assertEquals(details, todo.getDetails());
    }

    @Test
    void createWithOverlongDetailsIsRejected() throws Exception {
        // TEETH: goes red if the details max_len protovalidate rule is removed —
        // a 1001-char details would then pass and persist instead of 400-ing.
        HttpResponse<byte[]> response = postProto(
                CREATE_TODO,
                TodoOuterClass.CreateTodoRequest.newBuilder()
                        .setTitle("too-long-details")
                        .setDetails("d".repeat(DETAILS_MAX_LEN + 1))
                        .build());
        assertInvalidArgumentNaming(response, "details");
    }

    @Test
    void updateWithOverlongDetailsIsRejected() throws Exception {
        // The explicit-presence max_len rule also applies to UpdateTodoRequest.
        TodoOuterClass.Todo seeded = createTodo("update-details-target");
        HttpResponse<byte[]> response = postProto(
                UPDATE_TODO,
                TodoOuterClass.UpdateTodoRequest.newBuilder()
                        .setId(seeded.getId())
                        .setDetails("d".repeat(DETAILS_MAX_LEN + 1))
                        .build());
        assertInvalidArgumentNaming(response, "details");
    }

    // ---- client-supplied id: idempotent first-write-wins create over the wire ----

    /** A protovalidate-valid (lowercase UUIDv7-shaped) client id. */
    private static final String CLIENT_ID = "0190163d-8694-7afd-8912-1c3d4e5f6a7b";

    @Test
    void createWithClientIdEchoesTheSuppliedIdOverTheWire() throws Exception {
        // A binary POST carrying a client id persists and echoes exactly that id.
        HttpResponse<byte[]> response = postProto(
                CREATE_TODO,
                TodoOuterClass.CreateTodoRequest.newBuilder()
                        .setTitle("client-chosen")
                        .setId(CLIENT_ID)
                        .build());

        assertEquals(200, response.statusCode());
        TodoOuterClass.Todo todo =
                TodoOuterClass.CreateTodoResponse.parseFrom(response.body()).getTodo();
        assertEquals(CLIENT_ID, todo.getId(), "a supplied id must be echoed verbatim");
        assertEquals("client-chosen", todo.getTitle());
    }

    @Test
    void duplicateClientIdIsIdempotentFirstWriteWinsOverTheWire() throws Exception {
        // Re-sending the SAME id (a replayed offline-queue entry) returns the
        // EXISTING row as a 200 success, ignores the new payload, and adds no row.
        TodoOuterClass.Todo first = TodoOuterClass.CreateTodoResponse.parseFrom(postProto(
                                CREATE_TODO,
                                TodoOuterClass.CreateTodoRequest.newBuilder()
                                        .setTitle("original title")
                                        .setId(CLIENT_ID)
                                        .build())
                        .body())
                .getTodo();

        HttpResponse<byte[]> replay = postProto(
                CREATE_TODO,
                TodoOuterClass.CreateTodoRequest.newBuilder()
                        .setTitle("REPLAYED different title")
                        .setId(CLIENT_ID)
                        .build());

        assertEquals(200, replay.statusCode(), "an idempotent replay is a 200 success, not a conflict error");
        TodoOuterClass.Todo replayed =
                TodoOuterClass.CreateTodoResponse.parseFrom(replay.body()).getTodo();
        assertEquals("original title", replayed.getTitle(), "first-write-wins: the replay payload must be ignored");
        assertEquals(first.getCreatedAt(), replayed.getCreatedAt(), "created_at must stay first-written");

        // The list still holds exactly one row — no duplicate was created.
        HttpResponse<byte[]> list = get(LIST_TODOS + "?connect=v1&encoding=proto&base64=1&message=");
        assertEquals(
                1,
                TodoOuterClass.ListTodosResponse.parseFrom(list.body()).getTodosCount(),
                "an idempotent replay must not create a second row");
    }

    @Test
    void createWithInvalidIdIsRejected() throws Exception {
        // TEETH: goes red if the id uuid protovalidate rule is removed — a
        // non-uuid client id would then pass the edge and reach the repository
        // instead of 400-ing. The same rule GetTodoRequest.id uses.
        HttpResponse<byte[]> response = postProto(
                CREATE_TODO,
                TodoOuterClass.CreateTodoRequest.newBuilder()
                        .setTitle("bad-id")
                        .setId("not-a-uuid")
                        .build());
        assertInvalidArgumentNaming(response, "id");
    }

    // ---- complementary full-stack surfaces (not part of the 18) ----

    @Test
    void jsonDebugCodecRoundTripsThroughRealService() throws Exception {
        // The adapter's JSON debug codec end to end: a JSON create is persisted and
        // its title comes back in a JSON response envelope (content-type mirrors the request).
        HttpRequest request = requestBuilder(CREATE_TODO)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{\"title\":\"json-debug-codec\"}"))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertEquals(200, response.statusCode());
        assertEquals(
                "application/json",
                response.headers().firstValue("content-type").orElse(""));
        String title = parseJson(response.body())
                .getFieldsOrThrow("todo")
                .getStructValue()
                .getFieldsOrThrow("title")
                .getStringValue();
        assertEquals("json-debug-codec", title);
    }

    @Test
    void unsupportedContentTypeIsRejectedWithHttp415() throws Exception {
        HttpRequest request = requestBuilder(GET_TODO)
                .header("Content-Type", "text/plain")
                .POST(HttpRequest.BodyPublishers.ofString("id=abc"))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertEquals(415, response.statusCode());
    }

    // ---- helpers ----

    /** Creates a todo over a binary Connect POST and returns the persisted proto (with its server id). */
    private static TodoOuterClass.Todo createTodo(String title) throws Exception {
        HttpResponse<byte[]> response = postProto(
                CREATE_TODO,
                TodoOuterClass.CreateTodoRequest.newBuilder().setTitle(title).build());
        assertEquals(200, response.statusCode(), "seed createTodo failed");
        TodoOuterClass.Todo todo =
                TodoOuterClass.CreateTodoResponse.parseFrom(response.body()).getTodo();
        assertNotEquals("", todo.getId(), "seed createTodo returned no id");
        return todo;
    }

    private static HttpRequest.Builder requestBuilder(String pathWithQuery) {
        return HttpRequest.newBuilder().uri(URI.create("http://localhost:" + server.port() + pathWithQuery));
    }

    private static HttpResponse<byte[]> postProto(String path, Message message) throws Exception {
        HttpRequest request = requestBuilder(path)
                .header("Content-Type", "application/proto")
                .header("Connect-Protocol-Version", "1")
                .POST(HttpRequest.BodyPublishers.ofByteArray(message.toByteArray()))
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofByteArray());
    }

    private static HttpResponse<byte[]> get(String pathWithQuery) throws Exception {
        return client.send(requestBuilder(pathWithQuery).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    /** connect-es encodes binary GET payloads as unpadded base64url. */
    private static String base64Url(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static Struct parseJson(byte[] body) throws Exception {
        Struct.Builder struct = Struct.newBuilder();
        JsonFormat.parser().merge(new String(body, StandardCharsets.UTF_8), struct);
        return struct.build();
    }

    private static void assertConnectError(HttpResponse<byte[]> response, int expectedStatus, String expectedCode)
            throws Exception {
        assertEquals(expectedStatus, response.statusCode());
        // Spec: error responses are always application/json, whatever the request codec.
        assertEquals(
                "application/json",
                response.headers().firstValue("content-type").orElse(""));
        assertEquals(
                expectedCode,
                parseJson(response.body()).getFieldsOrThrow("code").getStringValue());
    }

    /** A protovalidate violation: 400 invalid_argument whose message names the offending field. */
    private static void assertInvalidArgumentNaming(HttpResponse<byte[]> response, String field) throws Exception {
        assertConnectError(response, 400, "invalid_argument");
        String message = parseJson(response.body()).getFieldsOrThrow("message").getStringValue();
        assertTrue(message.contains(field), "message should name the violated field '" + field + "': " + message);
    }
}
