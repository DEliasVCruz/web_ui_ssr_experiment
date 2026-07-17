package com.webuipoc.connect;

import com.google.protobuf.Timestamp;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import todo.v1.TodoOuterClass;
import todo.v1.TodoServiceGrpc;

/**
 * Test fixture: an in-memory stub implementing the {@code todo.v1.TodoService}
 * descriptor. The adapter under test never sees this type — it is registered as
 * a plain {@link io.grpc.BindableService}.
 *
 * <p>{@code GetTodo} drives the error scenarios via the requested id. The magic
 * ids are syntactically valid UUIDs (all outside the UUIDv7 space the real
 * service generates) so they pass the protovalidate {@code string.uuid}
 * constraint on {@code GetTodoRequest.id} and reach the stub:
 *
 * <ul>
 *   <li>{@link #MISSING_ID} → {@code onError(NOT_FOUND)}</li>
 *   <li>{@link #errorId}(code) → {@code onError(<code>)}, e.g.
 *       {@code errorId(Status.Code.DATA_LOSS)}</li>
 *   <li>{@link #THROW_ID} → throws {@link io.grpc.StatusRuntimeException}
 *       synchronously (PERMISSION_DENIED) instead of using the observer</li>
 *   <li>{@link #SLOW_ID} → responds asynchronously after 300ms (deadline tests)</li>
 *   <li>anything else → fixed todo echoing the id</li>
 * </ul>
 */
final class StubTodoService extends TodoServiceGrpc.TodoServiceImplBase {

    static final long SLOW_RESPONSE_MS = 300;

    /** GetTodo with this id responds NOT_FOUND ({@code todo "<id>" not found}). */
    static final String MISSING_ID = "00000000-0000-0000-0000-000000000404";
    /** GetTodo with this id throws StatusRuntimeException(PERMISSION_DENIED) synchronously. */
    static final String THROW_ID = "00000000-0000-0000-0000-000000000403";
    /** GetTodo with this id responds asynchronously after {@link #SLOW_RESPONSE_MS}. */
    static final String SLOW_ID = "00000000-0000-0000-0000-000000000504";
    /** Last-group prefix for {@link #errorId}: the final two digits carry the gRPC code value. */
    private static final String ERROR_ID_PREFIX = "00000000-0000-0000-0000-0000000000";

    /** The magic GetTodo id that makes the stub respond onError with the given code. */
    static String errorId(Status.Code code) {
        return String.format(Locale.ROOT, "%s%02d", ERROR_ID_PREFIX, code.value());
    }

    private static final Timestamp FIXED_TIME =
            Timestamp.newBuilder().setSeconds(1_700_000_000L).build();

    private static TodoOuterClass.Todo todo(String id, String title) {
        return TodoOuterClass.Todo.newBuilder()
                .setId(id)
                .setTitle(title)
                .setCompleted(false)
                .setCreatedAt(FIXED_TIME)
                .setUpdatedAt(FIXED_TIME)
                .build();
    }

    @Override
    public void listTodos(
            TodoOuterClass.ListTodosRequest request,
            StreamObserver<TodoOuterClass.ListTodosResponse> responseObserver) {
        responseObserver.onNext(TodoOuterClass.ListTodosResponse.newBuilder()
                .addTodos(todo("todo-1", "first"))
                .addTodos(todo("todo-2", "second"))
                .build());
        responseObserver.onCompleted();
    }

    @Override
    public void getTodo(
            TodoOuterClass.GetTodoRequest request, StreamObserver<TodoOuterClass.GetTodoResponse> responseObserver) {
        String id = request.getId();
        if (MISSING_ID.equals(id)) {
            responseObserver.onError(Status.NOT_FOUND
                    .withDescription("todo \"" + id + "\" not found")
                    .asRuntimeException());
            return;
        }
        if (id.startsWith(ERROR_ID_PREFIX)) {
            Status.Code code = Status.fromCodeValue(Integer.parseInt(id.substring(ERROR_ID_PREFIX.length())))
                    .getCode();
            responseObserver.onError(code.toStatus()
                    .withDescription("stub failure with code " + code.name())
                    .asRuntimeException());
            return;
        }
        if (THROW_ID.equals(id)) {
            throw Status.PERMISSION_DENIED
                    .withDescription("thrown synchronously from the implementation")
                    .asRuntimeException();
        }
        if (SLOW_ID.equals(id)) {
            CompletableFuture.delayedExecutor(SLOW_RESPONSE_MS, TimeUnit.MILLISECONDS)
                    .execute(() -> {
                        responseObserver.onNext(TodoOuterClass.GetTodoResponse.newBuilder()
                                .setTodo(todo(id, "slow-todo"))
                                .build());
                        responseObserver.onCompleted();
                    });
            return;
        }
        responseObserver.onNext(TodoOuterClass.GetTodoResponse.newBuilder()
                .setTodo(todo(id, "stub-todo"))
                .build());
        responseObserver.onCompleted();
    }

    @Override
    public void createTodo(
            TodoOuterClass.CreateTodoRequest request,
            StreamObserver<TodoOuterClass.CreateTodoResponse> responseObserver) {
        responseObserver.onNext(TodoOuterClass.CreateTodoResponse.newBuilder()
                .setTodo(todo("created-1", request.getTitle()))
                .build());
        responseObserver.onCompleted();
    }

    @Override
    public void updateTodo(
            TodoOuterClass.UpdateTodoRequest request,
            StreamObserver<TodoOuterClass.UpdateTodoResponse> responseObserver) {
        responseObserver.onNext(TodoOuterClass.UpdateTodoResponse.newBuilder()
                .setTodo(todo(request.getId(), request.hasTitle() ? request.getTitle() : "unchanged"))
                .build());
        responseObserver.onCompleted();
    }

    @Override
    public void deleteTodo(
            TodoOuterClass.DeleteTodoRequest request,
            StreamObserver<TodoOuterClass.DeleteTodoResponse> responseObserver) {
        responseObserver.onNext(TodoOuterClass.DeleteTodoResponse.getDefaultInstance());
        responseObserver.onCompleted();
    }
}
