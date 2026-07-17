package com.webuipoc.businesslogic.mapper;

import com.google.protobuf.Timestamp;
import com.webuipoc.businesslogic.domain.CreateTodo;
import com.webuipoc.businesslogic.domain.UpdateTodo;
import java.time.Instant;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.ReportingPolicy;
import todo.v1.TodoOuterClass;

/**
 * MapStruct mapper between the protobuf wire types and the domain model.
 *
 * <p>Default component model: the generated {@code TodoMapperImpl} is a plain
 * class with a public no-arg constructor, registered as an avaje-inject bean by
 * {@code AppFactory} (a hand-written {@code @Bean} factory method). This avoids
 * relying on cross-annotation-processor detection of a MapStruct-emitted
 * {@code @Singleton}.
 *
 * <p>{@code unmappedTargetPolicy = IGNORE} because protobuf builders expose many
 * writable properties (byte-string variants, etc.) beyond the message's logical
 * fields.
 */
@Mapper(unmappedTargetPolicy = ReportingPolicy.IGNORE)
public interface TodoMapper {

    /** {@code CreateTodoRequest.title} -&gt; {@code CreateTodo(title)}. */
    CreateTodo toCreateCommand(TodoOuterClass.CreateTodoRequest request);

    /**
     * {@code UpdateTodoRequest} -&gt; {@code UpdateTodo}, translating editions-2023
     * explicit presence into the nullable-field convention: an unset title or
     * completed becomes {@code null} ("not provided"). MapStruct cannot infer
     * this from {@code getTitle()}/{@code getCompleted()} alone, so the presence
     * checks are written explicitly. {@code id} maps by name.
     */
    @Mapping(target = "title", expression = "java(request.hasTitle() ? request.getTitle() : null)")
    @Mapping(target = "completed", expression = "java(request.hasCompleted() ? request.getCompleted() : null)")
    UpdateTodo toUpdateCommand(TodoOuterClass.UpdateTodoRequest request);

    /** Domain {@code Todo} -&gt; wire {@code todo.v1.Todo} (Instant -&gt; Timestamp via {@link #toTimestamp}). */
    TodoOuterClass.Todo toProto(com.webuipoc.businesslogic.domain.Todo todo);

    /** Instant -&gt; {@code google.protobuf.Timestamp} (seconds + nanos), used for created_at/updated_at. */
    default Timestamp toTimestamp(Instant instant) {
        return Timestamp.newBuilder()
                .setSeconds(instant.getEpochSecond())
                .setNanos(instant.getNano())
                .build();
    }
}
