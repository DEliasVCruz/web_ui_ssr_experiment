package com.webuipoc.businesslogic.mapper;

import com.google.protobuf.Timestamp;
import com.webuipoc.businesslogic.domain.CreateTodo;
import com.webuipoc.businesslogic.domain.UpdateTodo;
import java.time.Instant;
import org.mapstruct.BeanMapping;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.NullValueCheckStrategy;
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

    /**
     * {@code CreateTodoRequest} -&gt; {@code CreateTodo}. {@code title} maps by
     * name; {@code details} has explicit presence, so an unset field becomes
     * {@code null} ("not provided") rather than the empty-string default — the
     * same explicit-presence translation used for {@code UpdateTodoRequest}.
     */
    @Mapping(target = "details", expression = "java(request.hasDetails() ? request.getDetails() : null)")
    CreateTodo toCreateCommand(TodoOuterClass.CreateTodoRequest request);

    /**
     * {@code UpdateTodoRequest} -&gt; {@code UpdateTodo}, translating editions-2023
     * explicit presence into the nullable-field convention: an unset title,
     * details, or completed becomes {@code null} ("not provided"). MapStruct
     * cannot infer this from the {@code getX()} accessors alone (they return the
     * default value when unset), so the presence checks are written explicitly.
     * {@code id} maps by name.
     */
    @Mapping(target = "title", expression = "java(request.hasTitle() ? request.getTitle() : null)")
    @Mapping(target = "details", expression = "java(request.hasDetails() ? request.getDetails() : null)")
    @Mapping(target = "completed", expression = "java(request.hasCompleted() ? request.getCompleted() : null)")
    UpdateTodo toUpdateCommand(TodoOuterClass.UpdateTodoRequest request);

    /**
     * Domain {@code Todo} -&gt; wire {@code todo.v1.Todo} (Instant -&gt; Timestamp via
     * {@link #toTimestamp}). {@code nullValueCheckStrategy = ALWAYS} because
     * {@code details} is nullable and the protobuf builder's {@code setDetails}
     * throws on {@code null}: a null-check must guard it so a null domain
     * {@code details} leaves the explicit-presence wire field unset (rather than
     * NPE-ing or writing an empty string). The other source fields are non-null,
     * so the extra guards are inert.
     */
    @BeanMapping(nullValueCheckStrategy = NullValueCheckStrategy.ALWAYS)
    TodoOuterClass.Todo toProto(com.webuipoc.businesslogic.domain.Todo todo);

    /** Instant -&gt; {@code google.protobuf.Timestamp} (seconds + nanos), used for created_at/updated_at. */
    default Timestamp toTimestamp(Instant instant) {
        return Timestamp.newBuilder()
                .setSeconds(instant.getEpochSecond())
                .setNanos(instant.getNano())
                .build();
    }
}
