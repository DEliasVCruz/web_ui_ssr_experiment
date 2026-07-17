package com.webuipoc.businesslogic.todo;

import com.webuipoc.businesslogic.domain.CreateTodo;
import com.webuipoc.businesslogic.domain.NotFoundException;
import com.webuipoc.businesslogic.domain.Todo;
import com.webuipoc.businesslogic.domain.UpdateTodo;
import com.webuipoc.businesslogic.mapper.TodoMapper;
import io.avaje.validation.ConstraintViolationException;
import io.avaje.validation.Validator;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import jakarta.inject.Singleton;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import todo.v1.TodoOuterClass.CreateTodoRequest;
import todo.v1.TodoOuterClass.CreateTodoResponse;
import todo.v1.TodoOuterClass.DeleteTodoRequest;
import todo.v1.TodoOuterClass.DeleteTodoResponse;
import todo.v1.TodoOuterClass.GetTodoRequest;
import todo.v1.TodoOuterClass.GetTodoResponse;
import todo.v1.TodoOuterClass.ListTodosRequest;
import todo.v1.TodoOuterClass.ListTodosResponse;
import todo.v1.TodoOuterClass.UpdateTodoRequest;
import todo.v1.TodoOuterClass.UpdateTodoResponse;

/**
 * The single class where gRPC's {@link StreamObserver} lives. It bridges the
 * generated {@code todo.v1.TodoService} contract to the domain: maps proto -&gt;
 * command via {@link TodoMapper}, applies business-rule validation via the
 * avaje {@link Validator}, invokes the plain {@link TodoService} core, maps the
 * domain result back to proto, and replies through the observer.
 *
 * <p>Domain failures are translated to gRPC status and delivered via
 * {@code onError}, so they propagate through the Connect adapter's error mapping:
 * {@link ConstraintViolationException} -&gt; {@code INVALID_ARGUMENT} (Connect
 * {@code invalid_argument}, HTTP 400) and {@link NotFoundException} -&gt;
 * {@code NOT_FOUND} (Connect {@code not_found}, HTTP 404).
 */
@Singleton
public class TodoGrpcBridge extends todo.v1.TodoServiceGrpc.TodoServiceImplBase {

    private final TodoService service;
    private final TodoMapper mapper;
    private final Validator validator;

    public TodoGrpcBridge(TodoService service, TodoMapper mapper, Validator validator) {
        this.service = service;
        this.mapper = mapper;
        this.validator = validator;
    }

    @Override
    public void listTodos(ListTodosRequest request, StreamObserver<ListTodosResponse> observer) {
        respond(observer, () -> {
            ListTodosResponse.Builder response = ListTodosResponse.newBuilder();
            for (Todo todo : service.listTodos()) {
                response.addTodos(mapper.toProto(todo));
            }
            return response.build();
        });
    }

    @Override
    public void getTodo(GetTodoRequest request, StreamObserver<GetTodoResponse> observer) {
        respond(
                observer,
                () -> GetTodoResponse.newBuilder()
                        .setTodo(mapper.toProto(service.getTodo(request.getId())))
                        .build());
    }

    @Override
    public void createTodo(CreateTodoRequest request, StreamObserver<CreateTodoResponse> observer) {
        respond(observer, () -> {
            CreateTodo command = mapper.toCreateCommand(request);
            validator.validate(command);
            return CreateTodoResponse.newBuilder()
                    .setTodo(mapper.toProto(service.createTodo(command)))
                    .build();
        });
    }

    @Override
    public void updateTodo(UpdateTodoRequest request, StreamObserver<UpdateTodoResponse> observer) {
        respond(observer, () -> {
            UpdateTodo command = mapper.toUpdateCommand(request);
            validator.validate(command);
            return UpdateTodoResponse.newBuilder()
                    .setTodo(mapper.toProto(service.updateTodo(command)))
                    .build();
        });
    }

    @Override
    public void deleteTodo(DeleteTodoRequest request, StreamObserver<DeleteTodoResponse> observer) {
        respond(observer, () -> {
            service.deleteTodo(request.getId());
            // The Bun service returns an empty message ({}).
            return DeleteTodoResponse.getDefaultInstance();
        });
    }

    /**
     * Runs {@code action} and replies through {@code observer}, translating the
     * domain failures to gRPC status. Any other runtime exception propagates to
     * the gRPC {@code ServerCallHandler} (mapped to {@code unknown}/{@code
     * internal}), exactly as before this refactor.
     */
    private static <T> void respond(StreamObserver<T> observer, Supplier<T> action) {
        try {
            observer.onNext(action.get());
            observer.onCompleted();
        } catch (ConstraintViolationException e) {
            observer.onError(invalidArgument(e));
        } catch (NotFoundException e) {
            observer.onError(Status.NOT_FOUND.withDescription(e.getMessage()).asRuntimeException());
        }
    }

    private static StatusRuntimeException invalidArgument(ConstraintViolationException e) {
        String description = e.violations().stream()
                .map(v -> v.field() == null || v.field().isEmpty() ? v.message() : v.field() + ": " + v.message())
                .collect(Collectors.joining("; ", "invalid request: ", ""));
        return Status.INVALID_ARGUMENT.withDescription(description).asRuntimeException();
    }
}
