package com.webuipoc.businesslogic.connect;

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
 * <p>{@code GetTodo} drives the error scenarios via the requested id:
 *
 * <ul>
 *   <li>{@code missing} → {@code onError(NOT_FOUND)}</li>
 *   <li>{@code error:<GRPC_CODE_NAME>} → {@code onError(<code>)}, e.g.
 *       {@code error:DATA_LOSS}</li>
 *   <li>{@code throw} → throws {@link io.grpc.StatusRuntimeException}
 *       synchronously (PERMISSION_DENIED) instead of using the observer</li>
 *   <li>{@code slow} → responds asynchronously after 300ms (deadline tests)</li>
 *   <li>anything else → fixed todo echoing the id</li>
 * </ul>
 */
final class StubTodoService extends TodoServiceGrpc.TodoServiceImplBase {

    static final long SLOW_RESPONSE_MS = 300;

    private static final Timestamp FIXED_TIME = Timestamp.newBuilder().setSeconds(1_700_000_000L).build();

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
    public void listTodos(TodoOuterClass.ListTodosRequest request,
                          StreamObserver<TodoOuterClass.ListTodosResponse> responseObserver) {
        responseObserver.onNext(TodoOuterClass.ListTodosResponse.newBuilder()
                .addTodos(todo("todo-1", "first"))
                .addTodos(todo("todo-2", "second"))
                .build());
        responseObserver.onCompleted();
    }

    @Override
    public void getTodo(TodoOuterClass.GetTodoRequest request,
                        StreamObserver<TodoOuterClass.GetTodoResponse> responseObserver) {
        String id = request.getId();
        if ("missing".equals(id)) {
            responseObserver.onError(Status.NOT_FOUND
                    .withDescription("todo \"missing\" not found")
                    .asRuntimeException());
            return;
        }
        if (id.startsWith("error:")) {
            Status.Code code = Status.Code.valueOf(id.substring("error:".length()).toUpperCase(Locale.ROOT));
            responseObserver.onError(code.toStatus()
                    .withDescription("stub failure with code " + code.name())
                    .asRuntimeException());
            return;
        }
        if ("throw".equals(id)) {
            throw Status.PERMISSION_DENIED
                    .withDescription("thrown synchronously from the implementation")
                    .asRuntimeException();
        }
        if ("slow".equals(id)) {
            CompletableFuture.delayedExecutor(SLOW_RESPONSE_MS, TimeUnit.MILLISECONDS).execute(() -> {
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
    public void createTodo(TodoOuterClass.CreateTodoRequest request,
                           StreamObserver<TodoOuterClass.CreateTodoResponse> responseObserver) {
        responseObserver.onNext(TodoOuterClass.CreateTodoResponse.newBuilder()
                .setTodo(todo("created-1", request.getTitle()))
                .build());
        responseObserver.onCompleted();
    }

    @Override
    public void updateTodo(TodoOuterClass.UpdateTodoRequest request,
                           StreamObserver<TodoOuterClass.UpdateTodoResponse> responseObserver) {
        responseObserver.onNext(TodoOuterClass.UpdateTodoResponse.newBuilder()
                .setTodo(todo(request.getId(), request.hasTitle() ? request.getTitle() : "unchanged"))
                .build());
        responseObserver.onCompleted();
    }

    @Override
    public void deleteTodo(TodoOuterClass.DeleteTodoRequest request,
                           StreamObserver<TodoOuterClass.DeleteTodoResponse> responseObserver) {
        responseObserver.onNext(TodoOuterClass.DeleteTodoResponse.getDefaultInstance());
        responseObserver.onCompleted();
    }
}
