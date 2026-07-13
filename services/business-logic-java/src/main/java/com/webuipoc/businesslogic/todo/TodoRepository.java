package com.webuipoc.businesslogic.todo;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Todo persistence, a port of the Bun service's {@code src/todo-repository.ts}:
 * same SQL (including {@code ORDER BY created_at DESC}), same UUIDv7 ids, and
 * the same timestamp string format ({@code new Date().toISOString()} —
 * ISO-8601 UTC with millisecond precision and a {@code Z} suffix).
 *
 * <p>Methods are synchronized because a single SQLite connection is shared,
 * matching the Bun service where one {@code bun:sqlite} Database is used from
 * a single-threaded event loop.
 */
public final class TodoRepository {

    /** One row of the todos table; completed stays an INTEGER as in the TS TodoRow. */
    public record TodoRow(String id, String title, int completed, String createdAt, String updatedAt) {
    }

    /** Formats like JS {@code new Date().toISOString()}: always exactly 3 fractional digits. */
    private static final DateTimeFormatter ISO_MILLIS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private final Connection connection;

    public TodoRepository(TodoDb db) {
        this.connection = db.connection();
    }

    public synchronized List<TodoRow> listTodos() {
        try (PreparedStatement statement =
                connection.prepareStatement("SELECT * FROM todos ORDER BY created_at DESC");
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

    public synchronized Optional<TodoRow> getTodo(String id) {
        try (PreparedStatement statement =
                connection.prepareStatement("SELECT * FROM todos WHERE id = ?")) {
            statement.setString(1, id);
            try (ResultSet rs = statement.executeQuery()) {
                return rs.next() ? Optional.of(toTodoRow(rs)) : Optional.empty();
            }
        } catch (SQLException e) {
            throw new IllegalStateException("getTodo failed", e);
        }
    }

    public synchronized TodoRow createTodo(String title) {
        String id = UuidV7.randomUuidV7();
        String now = nowIsoString();
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO todos (id, title, completed, created_at, updated_at) VALUES (?, ?, 0, ?, ?)")) {
            statement.setString(1, id);
            statement.setString(2, title);
            statement.setString(3, now);
            statement.setString(4, now);
            statement.executeUpdate();
        } catch (SQLException e) {
            throw new IllegalStateException("createTodo failed", e);
        }
        return getTodo(id).orElseThrow();
    }

    /**
     * Partial update: {@code null} means "field not provided" (the TS
     * {@code fields.title ?? existing.title} / {@code fields.completed === undefined}
     * fallbacks). Like the Bun code, the UPDATE — and therefore the
     * {@code updated_at} bump — happens even when neither field is provided.
     */
    public synchronized Optional<TodoRow> updateTodo(String id, String title, Boolean completed) {
        Optional<TodoRow> existingRow = getTodo(id);
        if (existingRow.isEmpty()) {
            return Optional.empty();
        }
        TodoRow existing = existingRow.get();

        String newTitle = title != null ? title : existing.title();
        int newCompleted = completed == null ? existing.completed() : (completed ? 1 : 0);
        String now = nowIsoString();

        try (PreparedStatement statement = connection.prepareStatement(
                "UPDATE todos SET title = ?, completed = ?, updated_at = ? WHERE id = ?")) {
            statement.setString(1, newTitle);
            statement.setInt(2, newCompleted);
            statement.setString(3, now);
            statement.setString(4, id);
            statement.executeUpdate();
        } catch (SQLException e) {
            throw new IllegalStateException("updateTodo failed", e);
        }
        return getTodo(id);
    }

    public synchronized boolean deleteTodo(String id) {
        try (PreparedStatement statement =
                connection.prepareStatement("DELETE FROM todos WHERE id = ?")) {
            statement.setString(1, id);
            return statement.executeUpdate() > 0;
        } catch (SQLException e) {
            throw new IllegalStateException("deleteTodo failed", e);
        }
    }

    private static String nowIsoString() {
        return ISO_MILLIS.format(Instant.now());
    }

    private static TodoRow toTodoRow(ResultSet rs) throws SQLException {
        return new TodoRow(
                rs.getString("id"),
                rs.getString("title"),
                rs.getInt("completed"),
                rs.getString("created_at"),
                rs.getString("updated_at"));
    }
}
