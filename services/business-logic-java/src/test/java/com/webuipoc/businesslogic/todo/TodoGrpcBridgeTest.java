package com.webuipoc.businesslogic.todo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.protobuf.Timestamp;
import com.webuipoc.businesslogic.mapper.TodoMapperImpl;
import io.avaje.validation.Validator;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import todo.v1.TodoOuterClass.CreateTodoRequest;
import todo.v1.TodoOuterClass.DeleteTodoRequest;
import todo.v1.TodoOuterClass.DeleteTodoResponse;
import todo.v1.TodoOuterClass.GetTodoRequest;
import todo.v1.TodoOuterClass.ListTodosRequest;
import todo.v1.TodoOuterClass.Todo;
import todo.v1.TodoOuterClass.UpdateTodoRequest;
import todo.v1.TodoServiceGrpc;

/**
 * Exercises {@link TodoGrpcBridge} (bridge -&gt; {@link TodoService} core -&gt;
 * {@link TodoRepository}) through a real in-process gRPC server and the
 * generated blocking stub, against the shared PostgreSQL container
 * ({@link PostgresSupport}, reset before each test). Asserts behavioral parity
 * with the Bun service (todo-service.ts / todo-repository.ts), plus the new
 * domain business rule: a blank title is rejected as {@code INVALID_ARGUMENT}.
 */
class TodoGrpcBridgeTest {

    private TodoRepository repository;
    private Server server;
    private ManagedChannel channel;
    private TodoServiceGrpc.TodoServiceBlockingStub stub;

    @BeforeEach
    void setUp() throws Exception {
        PostgresSupport.reset();
        repository = new TodoRepository(PostgresSupport.todoDb());
        TodoGrpcBridge bridge = new TodoGrpcBridge(
                new TodoService(repository),
                new TodoMapperImpl(),
                Validator.builder().build());
        String serverName = InProcessServerBuilder.generateName();
        server = InProcessServerBuilder.forName(serverName)
                .directExecutor()
                .addService(bridge)
                .build()
                .start();
        channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();
        stub = TodoServiceGrpc.newBlockingStub(channel);
    }

    @AfterEach
    void tearDown() {
        channel.shutdownNow();
        server.shutdownNow();
    }

    private Todo create(String title) {
        return stub.createTodo(CreateTodoRequest.newBuilder().setTitle(title).build())
                .getTodo();
    }

    private Todo createWithId(String id, String title) {
        return stub.createTodo(
                        CreateTodoRequest.newBuilder().setId(id).setTitle(title).build())
                .getTodo();
    }

    private Todo createWithDetails(String title, String details) {
        return stub.createTodo(CreateTodoRequest.newBuilder()
                        .setTitle(title)
                        .setDetails(details)
                        .build())
                .getTodo();
    }

    private Todo get(String id) {
        return stub.getTodo(GetTodoRequest.newBuilder().setId(id).build()).getTodo();
    }

    private List<Todo> list() {
        return stub.listTodos(ListTodosRequest.getDefaultInstance()).getTodosList();
    }

    // --- full CRUD round-trip -------------------------------------------------

    @Test
    void fullCrudRoundTrip() {
        Todo created = create("buy milk");
        assertFalse(created.getId().isEmpty());
        assertEquals("buy milk", created.getTitle());
        assertFalse(created.getCompleted());
        // On create, created_at and updated_at are the same instant (same `now`).
        assertEquals(created.getCreatedAt(), created.getUpdatedAt());

        Todo fetched = get(created.getId());
        assertEquals(created, fetched);

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(created.getId())
                        .setTitle("buy oat milk")
                        .setCompleted(true)
                        .build())
                .getTodo();
        assertEquals("buy oat milk", updated.getTitle());
        assertTrue(updated.getCompleted());
        assertEquals(created.getCreatedAt(), updated.getCreatedAt());

        assertEquals(List.of(updated), list());

        DeleteTodoResponse deleteResponse = stub.deleteTodo(
                DeleteTodoRequest.newBuilder().setId(created.getId()).build());
        // Same shape as the Bun service: an empty message.
        assertEquals(DeleteTodoResponse.getDefaultInstance(), deleteResponse);

        assertEquals(List.of(), list());
        assertNotFound(() -> get(created.getId()));
    }

    // --- client-supplied id: idempotent first-write-wins create -----------------

    /** A protovalidate-valid (lowercase UUIDv7-shaped) client id. */
    private static final String CLIENT_ID = "0190163d-8694-7afd-8912-1c3d4e5f6a7b";

    @Test
    void createWithClientIdEchoesTheSuppliedId() {
        // A supplied id is persisted verbatim and echoed back (not a fresh mint),
        // and the row is retrievable under exactly that id.
        Todo created = createWithId(CLIENT_ID, "client-chosen");
        assertEquals(CLIENT_ID, created.getId(), "a supplied id must be persisted verbatim");

        Todo fetched = get(CLIENT_ID);
        assertEquals("client-chosen", fetched.getTitle());
    }

    @Test
    void createWithoutIdMintsServerId() {
        // Existing behavior pinned: an absent id (the only path the current UI
        // takes) yields a server-minted UUIDv7, distinct from any client id.
        Todo created = create("server-minted");
        assertFalse(created.getId().isEmpty(), "absent id must be server-minted");
        assertTrue(
                created.getId().matches("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"),
                "server-minted id must be a UUIDv7: " + created.getId());
    }

    @Test
    void duplicateClientIdIsIdempotentFirstWriteWins() {
        // TEETH: goes red if the create stops being first-write-wins (e.g. an
        // ON CONFLICT DO UPDATE that upserts the title). Re-sending the SAME id —
        // a replayed offline-queue entry — must return the EXISTING row, ignore
        // the new payload, and add NO second row.
        Todo first = createWithId(CLIENT_ID, "original title");

        Todo replay = createWithId(CLIENT_ID, "REPLAYED different title");

        assertEquals(first.getId(), replay.getId(), "replay must resolve to the same id");
        assertEquals("original title", replay.getTitle(), "first-write-wins: the replay payload must be ignored");
        assertEquals(first.getCreatedAt(), replay.getCreatedAt(), "created_at must stay first-written (server truth)");
        assertEquals(
                first.getUpdatedAt(), replay.getUpdatedAt(), "updated_at must stay first-written (no upsert bump)");
        assertEquals(first, replay, "the whole row must be identical to the first write");

        assertEquals(1, list().size(), "an idempotent replay must not create a second row");
        assertEquals("original title", get(CLIENT_ID).getTitle(), "the stored row must remain the first write");
    }

    @Test
    void duplicateClientIdWithDivergentDetailsIsIgnored() {
        // First-write-wins covers EVERY payload field, not just title: a replay
        // carrying different (or newly added) DETAILS must not write them either —
        // the stored row comes back byte-for-byte as first written.
        Todo first = stub.createTodo(CreateTodoRequest.newBuilder()
                        .setId(CLIENT_ID)
                        .setTitle("original title")
                        .setDetails("original notes")
                        .build())
                .getTodo();

        Todo replay = stub.createTodo(CreateTodoRequest.newBuilder()
                        .setId(CLIENT_ID)
                        .setTitle("original title")
                        .setDetails("REPLAYED different notes")
                        .build())
                .getTodo();

        assertEquals("original notes", replay.getDetails(), "first-write-wins: replay details must be ignored");
        assertEquals(first, replay, "the whole row must be identical to the first write");
        assertEquals("original notes", get(CLIENT_ID).getDetails(), "the stored details must remain the first write");
        assertEquals(1, list().size(), "an idempotent replay must not create a second row");
    }

    // --- ListTodos ordering ----------------------------------------------------

    @Test
    void listTodosOrdersByCreatedAtDescending() throws Exception {
        Todo first = create("first");
        Thread.sleep(5); // ensure distinct millisecond timestamps
        Todo second = create("second");
        Thread.sleep(5);
        Todo third = create("third");

        List<Todo> todos = list();
        assertEquals(
                List.of(third.getId(), second.getId(), first.getId()),
                todos.stream().map(Todo::getId).toList(),
                "expected newest-first (ORDER BY created_at DESC)");
    }

    // --- UpdateTodo presence matrix ---------------------------------------------

    @Test
    void titleOnlyUpdatePreservesCompleted() {
        Todo todo = create("task");
        stub.updateTodo(UpdateTodoRequest.newBuilder()
                .setId(todo.getId())
                .setCompleted(true)
                .build());

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(todo.getId())
                        .setTitle("renamed")
                        .build())
                .getTodo();
        assertEquals("renamed", updated.getTitle());
        assertTrue(updated.getCompleted(), "title-only update must preserve completed=true");
    }

    @Test
    void completedOnlyUpdatePreservesTitle() {
        Todo todo = create("keep me");

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(todo.getId())
                        .setCompleted(true)
                        .build())
                .getTodo();
        assertEquals("keep me", updated.getTitle(), "completed-only update must preserve title");
        assertTrue(updated.getCompleted());
    }

    // --- details: presence-based create + partial update ------------------------

    @Test
    void createWithoutDetailsLeavesDetailsUnset() {
        // Explicit presence: a create that omits details persists NULL, so the
        // read-back todo has the details field unset ("no details").
        Todo created = create("no notes");
        assertFalse(created.hasDetails(), "details must be unset when not provided on create");

        Todo fetched = get(created.getId());
        assertFalse(fetched.hasDetails(), "read-back todo must also report details unset");
    }

    @Test
    void createWithDetailsRoundTrips() {
        Todo created = createWithDetails("with notes", "remember the milk");
        assertTrue(created.hasDetails());
        assertEquals("remember the milk", created.getDetails());

        Todo fetched = get(created.getId());
        assertEquals("remember the milk", fetched.getDetails(), "details must survive the round trip");
    }

    @Test
    void detailsOnlyUpdateSetsDetailsAndPreservesTitleAndCompleted() {
        // TEETH: this is the test that goes red if the details COALESCE is dropped
        // from TodoRepository.updateTodo — without it, a details-only update never
        // writes the column, so getDetails() would come back empty/unset.
        Todo todo = createWithDetails("keep title", "old notes");
        stub.updateTodo(UpdateTodoRequest.newBuilder()
                .setId(todo.getId())
                .setCompleted(true)
                .build());

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(todo.getId())
                        .setDetails("new notes")
                        .build())
                .getTodo();
        assertEquals("new notes", updated.getDetails(), "details-only update must write the new details");
        assertEquals("keep title", updated.getTitle(), "details-only update must preserve title");
        assertTrue(updated.getCompleted(), "details-only update must preserve completed=true");
    }

    @Test
    void titleOnlyUpdatePreservesDetails() {
        Todo todo = createWithDetails("task", "keep these notes");

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(todo.getId())
                        .setTitle("renamed")
                        .build())
                .getTodo();
        assertEquals("renamed", updated.getTitle());
        assertEquals("keep these notes", updated.getDetails(), "title-only update must preserve details");
    }

    @Test
    void explicitEmptyDetailsClearsContent() {
        // Explicit presence: providing "" is distinct from not providing details;
        // it clears the content (has_details == true, value == "").
        Todo todo = createWithDetails("task", "some notes");

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(todo.getId())
                        .setDetails("")
                        .build())
                .getTodo();
        assertTrue(updated.hasDetails(), "cleared details is still 'set' on the wire");
        assertEquals("", updated.getDetails(), "explicit empty details must clear the content");
    }

    @Test
    void updateWithoutDetailsPreservesExistingDetails() {
        Todo todo = createWithDetails("task", "unchanged notes");

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(todo.getId())
                        .setCompleted(true)
                        .build())
                .getTodo();
        assertEquals("unchanged notes", updated.getDetails(), "update that omits details must leave them unchanged");
    }

    @Test
    void explicitCompletedFalseIsApplied() {
        Todo todo = create("task");
        stub.updateTodo(UpdateTodoRequest.newBuilder()
                .setId(todo.getId())
                .setCompleted(true)
                .build());

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(todo.getId())
                        .setCompleted(false)
                        .build())
                .getTodo();
        assertFalse(updated.getCompleted(), "explicit completed=false must not be treated as unset");
    }

    @Test
    void explicitEmptyTitleRejectedAsInvalidArgument() {
        // Behavior change vs the pre-refactor TodoServiceImpl: an explicitly set
        // but blank title was previously written through to the repository. The
        // domain business rule (avaje @NullOrNotBlank) now rejects it as
        // INVALID_ARGUMENT — consistent with the wire (protovalidate min_len 1
        // already rejects "" over Connect); the bridge extends that to a single
        // space too (blank-after-trim).
        Todo todo = create("has a title");

        StatusRuntimeException e = assertThrows(
                StatusRuntimeException.class,
                () -> stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(todo.getId())
                        .setTitle("")
                        .build()));
        assertEquals(Status.Code.INVALID_ARGUMENT, e.getStatus().getCode());
        String description = e.getStatus().getDescription();
        assertNotNull(description, "an INVALID_ARGUMENT status must carry a description");
        assertTrue(description.contains("title"), "description should name the title field: " + description);
    }

    @Test
    void updateWithNeitherFieldSetStillBumpsUpdatedAt() throws Exception {
        // The Bun repository runs the UPDATE (and bumps updated_at) even when
        // no field is provided — mirror that exactly.
        Todo todo = create("untouched");
        Thread.sleep(5);

        Todo updated = stub.updateTodo(
                        UpdateTodoRequest.newBuilder().setId(todo.getId()).build())
                .getTodo();
        assertEquals("untouched", updated.getTitle());
        assertFalse(updated.getCompleted());
        assertEquals(todo.getCreatedAt(), updated.getCreatedAt());
        assertTrue(
                isAfter(updated.getUpdatedAt(), todo.getUpdatedAt()),
                "updated_at must be bumped even when no field is set");
    }

    // --- NOT_FOUND semantics ------------------------------------------------------

    @Test
    void getMissingTodoIsNotFound() {
        assertNotFound(() -> get("missing-id"));
    }

    @Test
    void updateMissingTodoIsNotFound() {
        assertNotFound(() -> stub.updateTodo(UpdateTodoRequest.newBuilder()
                .setId("missing-id")
                .setTitle("nope")
                .build()));
    }

    @Test
    void deleteMissingTodoIsNotFound() {
        assertNotFound(() -> stub.deleteTodo(
                DeleteTodoRequest.newBuilder().setId("missing-id").build()));
    }

    private static boolean isAfter(Timestamp a, Timestamp b) {
        return a.getSeconds() > b.getSeconds() || (a.getSeconds() == b.getSeconds() && a.getNanos() > b.getNanos());
    }

    private static void assertNotFound(org.junit.jupiter.api.function.Executable call) {
        StatusRuntimeException e = assertThrows(StatusRuntimeException.class, call);
        assertEquals(Status.Code.NOT_FOUND, e.getStatus().getCode());
        // Same message string as the Bun service's ConnectError.
        assertEquals("todo not found", e.getStatus().getDescription());
    }

    // --- id and timestamp formats ---------------------------------------------------

    @Test
    void createdIdsAreUuidV7() {
        Todo todo = create("id check");
        assertTrue(
                todo.getId().matches("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"),
                "not a UUIDv7: " + todo.getId());
    }

    @Test
    void storedTimestampsHaveMillisecondPrecisionMatchingProto() {
        Todo todo = create("timestamp check");

        // Inspect the stored instants, not the protobuf round-trip. The repository
        // truncates to milliseconds to preserve the Bun service's
        // new Date().toISOString() granularity (Postgres timestamptz would
        // otherwise keep microseconds).
        TodoRepository.TodoRow row = repository.getTodo(todo.getId()).orElseThrow();
        assertEquals(
                0,
                row.createdAt().getNano() % 1_000_000,
                "created_at must be millisecond-precision: " + row.createdAt());
        assertEquals(
                0,
                row.updatedAt().getNano() % 1_000_000,
                "updated_at must be millisecond-precision: " + row.updatedAt());

        // And the proto Timestamp is the exact instant of the stored value.
        assertEquals(row.createdAt().getEpochSecond(), todo.getCreatedAt().getSeconds());
        assertEquals(row.createdAt().getNano(), todo.getCreatedAt().getNanos());
    }
}
