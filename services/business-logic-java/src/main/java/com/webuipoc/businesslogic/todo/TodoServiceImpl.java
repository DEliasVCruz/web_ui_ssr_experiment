package com.webuipoc.businesslogic.todo;

import com.google.protobuf.Timestamp;
import com.webuipoc.businesslogic.todo.TodoRepository.TodoRow;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import java.time.Instant;
import java.util.Optional;
import todo.v1.TodoOuterClass.CreateTodoRequest;
import todo.v1.TodoOuterClass.CreateTodoResponse;
import todo.v1.TodoOuterClass.DeleteTodoRequest;
import todo.v1.TodoOuterClass.DeleteTodoResponse;
import todo.v1.TodoOuterClass.GetTodoRequest;
import todo.v1.TodoOuterClass.GetTodoResponse;
import todo.v1.TodoOuterClass.ListTodosRequest;
import todo.v1.TodoOuterClass.ListTodosResponse;
import todo.v1.TodoOuterClass.Todo;
import todo.v1.TodoOuterClass.UpdateTodoRequest;
import todo.v1.TodoOuterClass.UpdateTodoResponse;

/**
 * gRPC {@code todo.v1.TodoService} implementation, a port of the Bun service's
 * {@code src/todo-service.ts}: same response shapes, same {@code NOT_FOUND}
 * error with message {@code "todo not found"} on Get/Update/Delete of a
 * missing id, and the same explicit-presence handling for UpdateTodo (the TS
 * code's {@code isFieldSet} checks map to {@code hasTitle()}/{@code hasCompleted()}).
 */
public final class TodoServiceImpl extends todo.v1.TodoServiceGrpc.TodoServiceImplBase {

    /** Same message string as the Bun service's ConnectError (todo-service.ts). */
    static final String NOT_FOUND_MESSAGE = "todo not found";

    private final TodoRepository repository;

    public TodoServiceImpl(TodoRepository repository) {
        this.repository = repository;
    }

    @Override
    public void listTodos(ListTodosRequest request, StreamObserver<ListTodosResponse> responseObserver) {
        ListTodosResponse.Builder response = ListTodosResponse.newBuilder();
        for (TodoRow row : repository.listTodos()) {
            response.addTodos(todoFromRow(row));
        }
        responseObserver.onNext(response.build());
        responseObserver.onCompleted();
    }

    @Override
    public void getTodo(GetTodoRequest request, StreamObserver<GetTodoResponse> responseObserver) {
        Optional<TodoRow> row = repository.getTodo(request.getId());
        if (row.isEmpty()) {
            responseObserver.onError(notFound());
            return;
        }
        responseObserver.onNext(GetTodoResponse.newBuilder().setTodo(todoFromRow(row.get())).build());
        responseObserver.onCompleted();
    }

    @Override
    public void createTodo(CreateTodoRequest request, StreamObserver<CreateTodoResponse> responseObserver) {
        TodoRow row = repository.createTodo(request.getTitle());
        responseObserver.onNext(CreateTodoResponse.newBuilder().setTodo(todoFromRow(row)).build());
        responseObserver.onCompleted();
    }

    @Override
    public void updateTodo(UpdateTodoRequest request, StreamObserver<UpdateTodoResponse> responseObserver) {
        // Explicit presence (editions 2023): distinguish "unset" from "set to
        // the default value", exactly like isFieldSet(...) in todo-service.ts.
        String title = request.hasTitle() ? request.getTitle() : null;
        Boolean completed = request.hasCompleted() ? request.getCompleted() : null;

        Optional<TodoRow> row = repository.updateTodo(request.getId(), title, completed);
        if (row.isEmpty()) {
            responseObserver.onError(notFound());
            return;
        }
        responseObserver.onNext(UpdateTodoResponse.newBuilder().setTodo(todoFromRow(row.get())).build());
        responseObserver.onCompleted();
    }

    @Override
    public void deleteTodo(DeleteTodoRequest request, StreamObserver<DeleteTodoResponse> responseObserver) {
        if (!repository.deleteTodo(request.getId())) {
            responseObserver.onError(notFound());
            return;
        }
        // The Bun service returns an empty message ({}).
        responseObserver.onNext(DeleteTodoResponse.getDefaultInstance());
        responseObserver.onCompleted();
    }

    private static io.grpc.StatusRuntimeException notFound() {
        return Status.NOT_FOUND.withDescription(NOT_FOUND_MESSAGE).asRuntimeException();
    }

    /** Port of todoFromRow in todo-service.ts (Boolean(completed), ISO strings → Timestamp). */
    private static Todo todoFromRow(TodoRow row) {
        return Todo.newBuilder()
                .setId(row.id())
                .setTitle(row.title())
                .setCompleted(row.completed() != 0)
                .setCreatedAt(timestampFromIso(row.createdAt()))
                .setUpdatedAt(timestampFromIso(row.updatedAt()))
                .build();
    }

    /** Equivalent of timestampFromDate(new Date(isoString)) in the TS service. */
    private static Timestamp timestampFromIso(String isoString) {
        Instant instant = Instant.parse(isoString);
        return Timestamp.newBuilder()
                .setSeconds(instant.getEpochSecond())
                .setNanos(instant.getNano())
                .build();
    }
}
