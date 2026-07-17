package com.webuipoc.businesslogic.mapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.webuipoc.businesslogic.domain.CreateTodo;
import com.webuipoc.businesslogic.domain.Todo;
import com.webuipoc.businesslogic.domain.UpdateTodo;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import todo.v1.TodoOuterClass;

/**
 * Unit tests for {@link TodoMapper} (the MapStruct-generated
 * {@code TodoMapperImpl}), focused on the editions-2023 explicit-presence trap:
 * an unset {@code title}/{@code completed} on {@code UpdateTodoRequest} must map
 * to {@code null} ("not provided"), while a set field — including the default
 * value (empty string / false) — must map to that value.
 */
class TodoMapperTest {

    private final TodoMapper mapper = new TodoMapperImpl();

    @Test
    void createCommandMapsTitle() {
        CreateTodo command = mapper.toCreateCommand(TodoOuterClass.CreateTodoRequest.newBuilder()
                .setTitle("buy milk")
                .build());
        assertEquals("buy milk", command.title());
        assertNull(command.details(), "details was not set → must be null (not provided)");
    }

    @Test
    void createCommandMapsDetailsWhenSet() {
        CreateTodo command = mapper.toCreateCommand(TodoOuterClass.CreateTodoRequest.newBuilder()
                .setTitle("buy milk")
                .setDetails("2% organic")
                .build());
        assertEquals("2% organic", command.details());
    }

    @Test
    void createCommandMapsExplicitEmptyDetails() {
        // Explicit presence: a provided empty string is "set", not "not provided".
        CreateTodo command = mapper.toCreateCommand(TodoOuterClass.CreateTodoRequest.newBuilder()
                .setTitle("buy milk")
                .setDetails("")
                .build());
        assertEquals("", command.details(), "explicit empty details is provided, not null");
    }

    @Test
    void updateWithTitleSetMapsToValue() {
        UpdateTodo command = mapper.toUpdateCommand(TodoOuterClass.UpdateTodoRequest.newBuilder()
                .setId("id-1")
                .setTitle("renamed")
                .build());
        assertEquals("id-1", command.id());
        assertEquals("renamed", command.title());
        assertNull(command.details(), "details was not set → must be null (not provided)");
        assertNull(command.completed(), "completed was not set → must be null (not provided)");
    }

    @Test
    void updateWithDetailsSetMapsToValue() {
        UpdateTodo command = mapper.toUpdateCommand(TodoOuterClass.UpdateTodoRequest.newBuilder()
                .setId("id-1")
                .setDetails("new notes")
                .build());
        assertEquals("new notes", command.details());
        assertNull(command.title(), "title was not set → must be null (not provided)");
    }

    @Test
    void updateWithExplicitEmptyDetailsIsProvidedNotNull() {
        // Explicit presence: a provided empty string clears the details and must
        // NOT collapse to null (which would mean "leave unchanged").
        UpdateTodo command = mapper.toUpdateCommand(TodoOuterClass.UpdateTodoRequest.newBuilder()
                .setId("id-1")
                .setDetails("")
                .build());
        assertEquals("", command.details(), "explicit empty details is provided (clear), not null");
    }

    @Test
    void updateWithDetailsUnsetMapsToNull() {
        UpdateTodo command = mapper.toUpdateCommand(TodoOuterClass.UpdateTodoRequest.newBuilder()
                .setId("id-1")
                .setTitle("renamed")
                .build());
        assertNull(command.details(), "details was not set → must be null (not provided)");
    }

    @Test
    void updateWithTitleUnsetMapsToNull() {
        UpdateTodo command = mapper.toUpdateCommand(TodoOuterClass.UpdateTodoRequest.newBuilder()
                .setId("id-1")
                .setCompleted(true)
                .build());
        assertNull(command.title(), "title was not set → must be null (not provided)");
        assertEquals(Boolean.TRUE, command.completed());
    }

    @Test
    void updateWithExplicitDefaultValuesArePreserved() {
        // Editions-2023 explicit presence: an explicitly set empty title / false
        // completed are "provided" and must NOT collapse to null.
        UpdateTodo command = mapper.toUpdateCommand(TodoOuterClass.UpdateTodoRequest.newBuilder()
                .setId("id-1")
                .setTitle("")
                .setCompleted(false)
                .build());
        assertEquals("", command.title(), "explicit empty title is provided, not null");
        assertEquals(Boolean.FALSE, command.completed(), "explicit completed=false is provided, not null");
    }

    @Test
    void updateWithNeitherFieldSetMapsBothToNull() {
        UpdateTodo command = mapper.toUpdateCommand(
                TodoOuterClass.UpdateTodoRequest.newBuilder().setId("id-1").build());
        assertNull(command.title());
        assertNull(command.completed());
    }

    @Test
    void toProtoConvertsInstantsToTimestamps() {
        Instant created = Instant.parse("2026-07-14T10:15:30.123Z");
        Instant updated = Instant.parse("2026-07-14T10:16:00.000Z");
        TodoOuterClass.Todo proto = mapper.toProto(new Todo("id-1", "task", true, "the notes", created, updated));

        assertEquals("id-1", proto.getId());
        assertEquals("task", proto.getTitle());
        assertTrue(proto.getCompleted());
        assertEquals("the notes", proto.getDetails());
        assertTrue(proto.hasDetails(), "non-null details must set the explicit-presence field");
        assertEquals(created.getEpochSecond(), proto.getCreatedAt().getSeconds());
        assertEquals(created.getNano(), proto.getCreatedAt().getNanos());
        assertEquals(updated.getEpochSecond(), proto.getUpdatedAt().getSeconds());
        assertEquals(updated.getNano(), proto.getUpdatedAt().getNanos());
    }

    @Test
    void toProtoLeavesDetailsUnsetWhenNull() {
        // The nullValueCheckStrategy=ALWAYS guard: a null domain details must NOT
        // call the protobuf setter (which throws on null) and must leave the
        // explicit-presence wire field unset ("no details").
        Instant now = Instant.parse("2026-07-14T10:15:30.000Z");
        TodoOuterClass.Todo proto = mapper.toProto(new Todo("id-1", "task", false, null, now, now));

        assertFalse(proto.hasDetails(), "null details must leave the wire field unset");
        assertEquals("", proto.getDetails(), "unset details reads back as the empty-string default");
    }

    @Test
    void toProtoSetsExplicitEmptyDetails() {
        // An empty (but non-null) details is the "cleared" state: it must be set
        // on the wire (has_details == true), distinct from the null "unset" case.
        Instant now = Instant.parse("2026-07-14T10:15:30.000Z");
        TodoOuterClass.Todo proto = mapper.toProto(new Todo("id-1", "task", false, "", now, now));

        assertTrue(proto.hasDetails(), "empty (non-null) details must set the wire field (cleared state)");
        assertEquals("", proto.getDetails());
    }
}
