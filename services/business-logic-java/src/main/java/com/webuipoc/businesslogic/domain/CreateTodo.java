package com.webuipoc.businesslogic.domain;

import io.avaje.validation.constraints.NotBlank;
import io.avaje.validation.constraints.Valid;

/**
 * Command to create a todo. {@code @Valid} makes avaje-validator generate a
 * validation adapter for this record.
 *
 * <p>Business rule: {@code title} must be non-blank after trimming. The wire
 * rule (protovalidate {@code string.min_len = 1}) only guarantees length &ge; 1,
 * so a single space passes the wire but is rejected here — that is the gap this
 * layer closes.
 */
@Valid
public record CreateTodo(@NotBlank(message = "must not be blank") String title) {
}
