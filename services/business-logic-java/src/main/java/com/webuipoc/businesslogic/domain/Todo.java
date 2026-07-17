package com.webuipoc.businesslogic.domain;

import java.time.Instant;

/**
 * Domain representation of a todo, fully decoupled from protobuf and JDBC.
 *
 * <p>Timestamps are {@link Instant} (not proto {@code Timestamp} or ISO strings);
 * {@code completed} is a plain {@code boolean} (not the repository's INTEGER).
 * The MapStruct {@code TodoMapper} converts this to the wire {@code todo.v1.Todo}
 * and the {@code TodoService} converts repository rows into this.
 *
 * <p>{@code details} is nullable by the repo's plain-String convention:
 * {@code null} means "no details" (the persisted column is NULL / the wire field
 * is unset), while a non-null value — including the empty string — means details
 * were provided (an empty string is the "cleared" state). The MapStruct mapper
 * leaves the proto field unset when this is {@code null}.
 */
public record Todo(String id, String title, boolean completed, String details, Instant createdAt, Instant updatedAt) {}
