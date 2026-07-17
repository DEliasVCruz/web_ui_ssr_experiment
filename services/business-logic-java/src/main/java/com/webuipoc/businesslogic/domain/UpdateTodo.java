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
 *
 * <p>{@code details} carries NO business constraint: {@code null} means "not
 * provided" (leave unchanged), while a non-null value — including the empty
 * string — is a provided update (an empty string clears the details). The only
 * wire rule is the {@code max_len = 1000} cap enforced by protovalidate at the
 * edge, so there is nothing left for this layer to add.
 */
@Valid
public record UpdateTodo(String id, @NullOrNotBlank String title, String details, Boolean completed) {}
