package com.webuipoc.businesslogic.domain;

import io.avaje.validation.constraints.Valid;

/**
 * Command to update a todo. Nullable-field convention: {@code null} means "field
 * not provided" (the editions-2023 explicit-presence {@code unset} on
 * {@code UpdateTodoRequest.title}/{@code completed}), matching the repository's
 * partial-update contract exactly.
 *
 * <p>Business rule: {@code title}, <em>when present</em>, must be non-blank after
 * trimming — expressed by the custom {@link NullOrNotBlank} constraint (a bare
 * {@code @NotBlank} would wrongly reject the not-provided {@code null} case).
 */
@Valid
public record UpdateTodo(String id, @NullOrNotBlank String title, Boolean completed) {
}
