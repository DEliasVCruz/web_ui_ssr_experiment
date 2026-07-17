package com.webuipoc.businesslogic.domain;

import io.avaje.validation.constraints.NotBlank;
import io.avaje.validation.constraints.Valid;
import org.jspecify.annotations.Nullable;

/**
 * Command to create a todo. {@code @Valid} makes avaje-validator generate a
 * validation adapter for this record.
 *
 * <p>Business rule: {@code title} must be non-blank after trimming. The wire
 * rule (protovalidate {@code string.min_len = 1}) only guarantees length &ge; 1,
 * so a single space passes the wire but is rejected here — that is the gap this
 * layer closes.
 *
 * <p>{@code details} carries NO business constraint on purpose: unlike title,
 * blank/empty details are legal (they represent "no details"), and the only wire
 * rule is a length cap ({@code max_len = 1000}) already enforced by protovalidate
 * at the edge — duplicating it here would add nothing. {@code null} means "not
 * provided" (the request field was unset).
 *
 * <p>{@code id} is the optional client-supplied id (explicit presence): {@code
 * null} means "not provided" (the server mints a UUIDv7), a non-null value is the
 * client's chosen id, persisted verbatim for idempotent first-write-wins creates.
 * Like {@code details} it carries NO domain constraint — the uuid shape is a wire
 * rule protovalidate already enforces at the edge (400 invalid_argument), and
 * there is no additional business rule beyond it.
 */
@Valid
public record CreateTodo(
        @Nullable String id,
        @NotBlank(message = "must not be blank") String title,
        @Nullable String details) {}
