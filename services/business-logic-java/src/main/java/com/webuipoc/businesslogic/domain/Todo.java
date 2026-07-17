package com.webuipoc.businesslogic.domain;

import java.time.Instant;

/**
 * Domain representation of a todo, fully decoupled from protobuf and JDBC.
 *
 * <p>Timestamps are {@link Instant} (not proto {@code Timestamp} or ISO strings);
 * {@code completed} is a plain {@code boolean} (not the repository's INTEGER).
 * The MapStruct {@code TodoMapper} converts this to the wire {@code todo.v1.Todo}
 * and the {@code TodoService} converts repository rows into this.
 */
public record Todo(String id, String title, boolean completed, Instant createdAt, Instant updatedAt) {}
