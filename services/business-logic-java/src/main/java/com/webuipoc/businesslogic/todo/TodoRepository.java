package com.webuipoc.businesslogic.todo;

import jakarta.inject.Singleton;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Todo persistence over PostgreSQL, a port of the retired Bun service's
 * {@code src/todo-repository.ts}: same newest-first ordering ({@code created_at
 * DESC}, with {@code id DESC} as a deterministic same-millisecond tiebreaker),
 * same UUIDv7 ids, same "update always bumps updated_at" semantics.
 *
 * <p>Unlike the SQLite original (a single shared connection guarded by
 * {@code synchronized}), each method borrows a connection from the HikariCP pool
 * for the duration of the call and returns it — the pool provides the
 * concurrency isolation, so no method-level locking is needed.
 *
 * <p>Dialect notes vs the SQLite port:
 * <ul>
 *   <li>{@code completed} is a real {@code boolean} column (was INTEGER 0/1).</li>
 *   <li>Timestamps are {@code timestamptz}; the app writes millisecond-truncated
 *       instants (preserving Bun's {@code new Date().toISOString()} granularity)
 *       and reads them back as {@link Instant}.</li>
 *   <li>INSERT/UPDATE use {@code RETURNING} to read the persisted row back in
 *       one round trip (no follow-up SELECT), and UPDATE null-merges absent
 *       fields in-statement via {@code COALESCE} (atomic — no read-merge-write
 *       race across pooled connections).</li>
 * </ul>
 */
@Singleton
public final class TodoRepository {

    private static final String COLUMNS = "id, title, completed, created_at, updated_at";

    /** One row of the todos table: boolean completed, Instant timestamps (native Postgres types). */
    public record TodoRow(String id, String title, boolean completed, Instant createdAt, Instant updatedAt) {}

    private final TodoDb db;

    public TodoRepository(TodoDb db) {
        this.db = db;
    }

    public List<TodoRow> listTodos() {
        // id DESC tiebreaker: created_at is millisecond-truncated, so same-ms ties
        // are realistic; UUIDv7 ids are time-ordered, making id DESC the natural
        // (and deterministic) newest-first order within a tied millisecond.
        try (Connection connection = db.getConnection();
                PreparedStatement statement = connection.prepareStatement(
                        "SELECT " + COLUMNS + " FROM todos ORDER BY created_at DESC, id DESC");
                ResultSet rs = statement.executeQuery()) {
            List<TodoRow> rows = new ArrayList<>();
            while (rs.next()) {
                rows.add(toTodoRow(rs));
            }
            return rows;
        } catch (SQLException e) {
            throw new IllegalStateException("listTodos failed", e);
        }
    }

    public Optional<TodoRow> getTodo(String id) {
        try (Connection connection = db.getConnection();
                PreparedStatement statement =
                        connection.prepareStatement("SELECT " + COLUMNS + " FROM todos WHERE id = ?")) {
            statement.setString(1, id);
            try (ResultSet rs = statement.executeQuery()) {
                return rs.next() ? Optional.of(toTodoRow(rs)) : Optional.empty();
            }
        } catch (SQLException e) {
            throw new IllegalStateException("getTodo failed", e);
        }
    }

    public TodoRow createTodo(String title) {
        String id = UuidV7.randomUuidV7();
        OffsetDateTime now = nowMillis();
        try (Connection connection = db.getConnection();
                PreparedStatement statement = connection.prepareStatement(
                        "INSERT INTO todos (" + COLUMNS + ") VALUES (?, ?, false, ?, ?) RETURNING " + COLUMNS)) {
            statement.setString(1, id);
            statement.setString(2, title);
            statement.setObject(3, now);
            statement.setObject(4, now);
            try (ResultSet rs = statement.executeQuery()) {
                rs.next();
                return toTodoRow(rs);
            }
        } catch (SQLException e) {
            throw new IllegalStateException("createTodo failed", e);
        }
    }

    /**
     * Partial update: {@code null} means "field not provided" (the TS
     * {@code fields.title ?? existing.title} / {@code fields.completed === undefined}
     * fallbacks). Like the Bun code, the UPDATE — and therefore the
     * {@code updated_at} bump — happens even when neither field is provided.
     *
     * <p>The null-merge happens IN the statement ({@code COALESCE(?, column)}),
     * not in Java: a read-merge-write across two pooled connections would be a
     * lost-update race (two concurrent partial updates could silently drop one
     * field — the old synchronized-single-connection SQLite code serialized
     * these in-process). One atomic statement removes the race and the extra
     * round trip; 0 rows updated means the id does not exist (NOT_FOUND at the
     * service layer, exactly as before).
     */
    public Optional<TodoRow> updateTodo(String id, String title, Boolean completed) {
        try (Connection connection = db.getConnection();
                PreparedStatement statement = connection.prepareStatement(
                        "UPDATE todos SET title = COALESCE(?, title), completed = COALESCE(?, completed), "
                                + "updated_at = ? WHERE id = ? RETURNING " + COLUMNS)) {
            statement.setString(1, title);
            statement.setObject(2, completed);
            statement.setObject(3, nowMillis());
            statement.setString(4, id);
            try (ResultSet rs = statement.executeQuery()) {
                return rs.next() ? Optional.of(toTodoRow(rs)) : Optional.empty();
            }
        } catch (SQLException e) {
            throw new IllegalStateException("updateTodo failed", e);
        }
    }

    public boolean deleteTodo(String id) {
        try (Connection connection = db.getConnection();
                PreparedStatement statement = connection.prepareStatement("DELETE FROM todos WHERE id = ?")) {
            statement.setString(1, id);
            return statement.executeUpdate() > 0;
        } catch (SQLException e) {
            throw new IllegalStateException("deleteTodo failed", e);
        }
    }

    /**
     * {@code now()} truncated to milliseconds, at UTC. Truncation preserves the
     * retired Bun service's {@code new Date().toISOString()} millisecond
     * granularity (Postgres timestamptz would otherwise keep microseconds), so a
     * fresh create still reports {@code created_at == updated_at}.
     */
    private static OffsetDateTime nowMillis() {
        return Instant.now().truncatedTo(ChronoUnit.MILLIS).atOffset(ZoneOffset.UTC);
    }

    private static TodoRow toTodoRow(ResultSet rs) throws SQLException {
        return new TodoRow(
                rs.getString("id"),
                rs.getString("title"),
                rs.getBoolean("completed"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant(),
                rs.getObject("updated_at", OffsetDateTime.class).toInstant());
    }
}
