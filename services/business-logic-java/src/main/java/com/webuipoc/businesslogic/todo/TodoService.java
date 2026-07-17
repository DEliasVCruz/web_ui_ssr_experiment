package com.webuipoc.businesslogic.todo;

import com.webuipoc.businesslogic.domain.CreateTodo;
import com.webuipoc.businesslogic.domain.NotFoundException;
import com.webuipoc.businesslogic.domain.Todo;
import com.webuipoc.businesslogic.domain.UpdateTodo;
import com.webuipoc.businesslogic.todo.TodoRepository.TodoRow;
import jakarta.inject.Singleton;
import java.time.Instant;
import java.util.List;

/**
 * Business core for todos: plain blocking methods over the domain model, no
 * protobuf and no {@code StreamObserver}. Delegates persistence to
 * {@link TodoRepository} (whose semantics — UUIDv7 ids, ISO-millis timestamps,
 * WAL single connection — are unchanged) and converts repository rows into the
 * domain {@link Todo}. Missing-todo operations throw {@link NotFoundException},
 * which the gRPC bridge maps to {@code NOT_FOUND}.
 */
@Singleton
public class TodoService {

    /** Same message string the Bun service's ConnectError used. */
    static final String NOT_FOUND_MESSAGE = "todo not found";

    private final TodoRepository repository;

    public TodoService(TodoRepository repository) {
        this.repository = repository;
    }

    public Todo createTodo(CreateTodo command) {
        return toDomain(repository.createTodo(command.title()));
    }

    public List<Todo> listTodos() {
        return repository.listTodos().stream().map(TodoService::toDomain).toList();
    }

    public Todo getTodo(String id) {
        return repository.getTodo(id).map(TodoService::toDomain).orElseThrow(TodoService::notFound);
    }

    public Todo updateTodo(UpdateTodo command) {
        return repository
                .updateTodo(command.id(), command.title(), command.completed())
                .map(TodoService::toDomain)
                .orElseThrow(TodoService::notFound);
    }

    public void deleteTodo(String id) {
        if (!repository.deleteTodo(id)) {
            throw notFound();
        }
    }

    private static NotFoundException notFound() {
        return new NotFoundException(NOT_FOUND_MESSAGE);
    }

    /** Repository row (INTEGER completed, ISO-millis strings) -&gt; domain Todo (boolean, Instant). */
    private static Todo toDomain(TodoRow row) {
        return new Todo(
                row.id(),
                row.title(),
                row.completed() != 0,
                Instant.parse(row.createdAt()),
                Instant.parse(row.updatedAt()));
    }
}
