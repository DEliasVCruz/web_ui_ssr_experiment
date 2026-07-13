package com.webuipoc.businesslogic.todo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.protobuf.Timestamp;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import todo.v1.TodoOuterClass.CreateTodoRequest;
import todo.v1.TodoOuterClass.DeleteTodoRequest;
import todo.v1.TodoOuterClass.DeleteTodoResponse;
import todo.v1.TodoOuterClass.GetTodoRequest;
import todo.v1.TodoOuterClass.ListTodosRequest;
import todo.v1.TodoOuterClass.Todo;
import todo.v1.TodoOuterClass.UpdateTodoRequest;
import todo.v1.TodoServiceGrpc;

/**
 * Exercises {@link TodoServiceImpl} through a real in-process gRPC server and
 * the generated blocking stub, against a fresh temp-file SQLite database, and
 * asserts behavioral parity with the Bun service (todo-service.ts /
 * todo-repository.ts).
 */
class TodoServiceImplTest {

    @TempDir
    Path tempDir;

    private TodoDb db;
    private TodoRepository repository;
    private Server server;
    private ManagedChannel channel;
    private TodoServiceGrpc.TodoServiceBlockingStub stub;

    @BeforeEach
    void setUp() throws Exception {
        db = new TodoDb(tempDir.resolve("todos.db").toString());
        repository = new TodoRepository(db);
        String serverName = InProcessServerBuilder.generateName();
        server = InProcessServerBuilder.forName(serverName)
                .directExecutor()
                .addService(new TodoServiceImpl(repository))
                .build()
                .start();
        channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();
        stub = TodoServiceGrpc.newBlockingStub(channel);
    }

    @AfterEach
    void tearDown() {
        channel.shutdownNow();
        server.shutdownNow();
        db.close();
    }

    private Todo create(String title) {
        return stub.createTodo(CreateTodoRequest.newBuilder().setTitle(title).build()).getTodo();
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

        DeleteTodoResponse deleteResponse =
                stub.deleteTodo(DeleteTodoRequest.newBuilder().setId(created.getId()).build());
        // Same shape as the Bun service: an empty message.
        assertEquals(DeleteTodoResponse.getDefaultInstance(), deleteResponse);

        assertEquals(List.of(), list());
        assertNotFound(() -> get(created.getId()));
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
        stub.updateTodo(UpdateTodoRequest.newBuilder().setId(todo.getId()).setCompleted(true).build());

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

    @Test
    void explicitCompletedFalseIsApplied() {
        Todo todo = create("task");
        stub.updateTodo(UpdateTodoRequest.newBuilder().setId(todo.getId()).setCompleted(true).build());

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(todo.getId())
                        .setCompleted(false)
                        .build())
                .getTodo();
        assertFalse(updated.getCompleted(), "explicit completed=false must not be treated as unset");
    }

    @Test
    void explicitEmptyTitleIsApplied() {
        Todo todo = create("has a title");

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder()
                        .setId(todo.getId())
                        .setTitle("")
                        .build())
                .getTodo();
        assertEquals("", updated.getTitle(), "explicit empty title must not be treated as unset");
    }

    @Test
    void updateWithNeitherFieldSetStillBumpsUpdatedAt() throws Exception {
        // The Bun repository runs the UPDATE (and bumps updated_at) even when
        // no field is provided — mirror that exactly.
        Todo todo = create("untouched");
        Thread.sleep(5);

        Todo updated = stub.updateTodo(UpdateTodoRequest.newBuilder().setId(todo.getId()).build())
                .getTodo();
        assertEquals("untouched", updated.getTitle());
        assertFalse(updated.getCompleted());
        assertEquals(todo.getCreatedAt(), updated.getCreatedAt());
        assertTrue(isAfter(updated.getUpdatedAt(), todo.getUpdatedAt()),
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
        return a.getSeconds() > b.getSeconds()
                || (a.getSeconds() == b.getSeconds() && a.getNanos() > b.getNanos());
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
        assertTrue(todo.getId().matches(
                        "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"),
                "not a UUIDv7: " + todo.getId());
    }

    @Test
    void storedTimestampStringsMatchBunToIsoStringFormat() {
        Todo todo = create("timestamp check");

        // Inspect the raw stored strings, not the protobuf round-trip.
        TodoRepository.TodoRow row = repository.getTodo(todo.getId()).orElseThrow();
        assertTrue(TodoDbTest.BUN_ISO_MILLIS.matcher(row.createdAt()).matches(),
                "created_at not in new Date().toISOString() format: " + row.createdAt());
        assertTrue(TodoDbTest.BUN_ISO_MILLIS.matcher(row.updatedAt()).matches(),
                "updated_at not in new Date().toISOString() format: " + row.updatedAt());

        // And the proto Timestamp is the exact instant of the stored string.
        Instant stored = Instant.parse(row.createdAt());
        assertEquals(stored.getEpochSecond(), todo.getCreatedAt().getSeconds());
        assertEquals(stored.getNano(), todo.getCreatedAt().getNanos());
    }
}
