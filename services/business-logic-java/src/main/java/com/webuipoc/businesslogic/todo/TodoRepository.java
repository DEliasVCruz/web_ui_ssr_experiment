package com.webuipoc.businesslogic.todo;

import static com.webuipoc.jooq.Tables.TODOS;

import com.webuipoc.jooq.tables.records.TodosRecord;
import jakarta.inject.Singleton;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import org.jooq.DSLContext;
import org.jooq.SQLDialect;
import org.jooq.impl.DSL;

/**
 * Todo persistence over PostgreSQL via the jOOQ typed DSL (task wdt.4), a port
 * of the plain-JDBC repository that itself ported the retired Bun service's
 * {@code src/todo-repository.ts}: same newest-first ordering ({@code created_at
 * DESC}, with {@code id DESC} as a deterministic same-millisecond tiebreaker),
 * same UUIDv7 ids, same "update always bumps updated_at" semantics.
 *
 * <p>The queries are built against the generated {@code com.webuipoc.jooq}
 * metamodel ({@code Tables.TODOS}), which the build regenerates from the REAL
 * migrated catalog (a throwaway Postgres container + this repo's Flyway
 * migrations) on every compile — so a schema/query mismatch is a compile error,
 * not a runtime surprise.
 *
 * <p>DSLContext lifecycle: ONE {@link DSLContext} is created per repository
 * instance via {@code DSL.using(dataSource, POSTGRES)}. Backed by a
 * {@code DataSource}, a DSLContext is thread-safe and connectionless — each
 * statement borrows a pooled connection from HikariCP and returns it when the
 * fetch completes, exactly the borrow-per-call discipline the JDBC version had,
 * without rebuilding the (immutable) jOOQ {@code Configuration} on every call.
 * Default {@code Settings} are used deliberately: the only non-default the old
 * code expressed in SQL text (dialect-native {@code RETURNING}, {@code
 * COALESCE}) is first-class in the POSTGRES dialect.
 *
 * <p>Error contract: jOOQ wraps every {@code SQLException} in its unchecked
 * {@code org.jooq.exception.DataAccessException} — the same "DB failure
 * surfaces as an unchecked exception, mapped to INTERNAL at the gRPC edge"
 * contract the previous IllegalStateException wrapping provided.
 *
 * <p>Dialect/semantics notes preserved from the JDBC port:
 * <ul>
 *   <li>{@code completed} is a real {@code boolean} column.</li>
 *   <li>Timestamps are {@code timestamptz}; the app writes millisecond-truncated
 *       instants (preserving Bun's {@code new Date().toISOString()} granularity)
 *       and reads them back as {@link Instant}.</li>
 *   <li>INSERT/UPDATE use {@code RETURNING} to read the persisted row back in
 *       one round trip (no follow-up SELECT), and UPDATE null-merges absent
 *       fields in-statement via {@code COALESCE} (atomic — no read-merge-write
 *       race across pooled connections).</li>
 *   <li>{@code id} is case-sensitive {@code text}: {@code TODOS.ID.eq(id)} is an
 *       exact text comparison, so an upper-cased UUID must still MISS.</li>
 * </ul>
 */
@Singleton
public final class TodoRepository {

    /** One row of the todos table: boolean completed, Instant timestamps (native Postgres types). */
    public record TodoRow(String id, String title, boolean completed, Instant createdAt, Instant updatedAt) {}

    private final DSLContext dsl;

    public TodoRepository(TodoDb db) {
        this.dsl = DSL.using(db.dataSource(), SQLDialect.POSTGRES);
    }

    public List<TodoRow> listTodos() {
        // id DESC tiebreaker: created_at is millisecond-truncated, so same-ms ties
        // are realistic; UUIDv7 ids are time-ordered, making id DESC the natural
        // (and deterministic) newest-first order within a tied millisecond.
        return dsl.selectFrom(TODOS)
                .orderBy(TODOS.CREATED_AT.desc(), TODOS.ID.desc())
                .fetch(TodoRepository::toTodoRow);
    }

    public Optional<TodoRow> getTodo(String id) {
        return dsl.selectFrom(TODOS).where(TODOS.ID.eq(id)).fetchOptional(TodoRepository::toTodoRow);
    }

    public TodoRow createTodo(String title) {
        OffsetDateTime now = nowMillis();
        return toTodoRow(dsl.insertInto(TODOS)
                .set(TODOS.ID, UuidV7.randomUuidV7())
                .set(TODOS.TITLE, title)
                .set(TODOS.COMPLETED, false)
                .set(TODOS.CREATED_AT, now)
                .set(TODOS.UPDATED_AT, now)
                .returning()
                .fetchSingle());
    }

    /**
     * Partial update: {@code null} means "field not provided" (the TS
     * {@code fields.title ?? existing.title} / {@code fields.completed === undefined}
     * fallbacks). Like the Bun code, the UPDATE — and therefore the
     * {@code updated_at} bump — happens even when neither field is provided.
     *
     * <p>The null-merge happens IN the statement ({@code coalesce(?, column)},
     * rendered from {@code DSL.coalesce(DSL.val(...), column)}), not in Java: a
     * read-merge-write across two pooled connections would be a lost-update race
     * (two concurrent partial updates could silently drop one field). One atomic
     * statement removes the race and the extra round trip; an empty
     * {@code RETURNING} result means the id does not exist (NOT_FOUND at the
     * service layer, exactly as before).
     */
    public Optional<TodoRow> updateTodo(String id, String title, Boolean completed) {
        return dsl.update(TODOS)
                .set(TODOS.TITLE, DSL.coalesce(DSL.val(title, TODOS.TITLE), TODOS.TITLE))
                .set(TODOS.COMPLETED, DSL.coalesce(DSL.val(completed, TODOS.COMPLETED), TODOS.COMPLETED))
                .set(TODOS.UPDATED_AT, nowMillis())
                .where(TODOS.ID.eq(id))
                .returning()
                .fetchOptional()
                .map(TodoRepository::toTodoRow);
    }

    public boolean deleteTodo(String id) {
        return dsl.deleteFrom(TODOS).where(TODOS.ID.eq(id)).execute() > 0;
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

    private static TodoRow toTodoRow(TodosRecord record) {
        return new TodoRow(
                record.getId(),
                record.getTitle(),
                record.getCompleted(),
                record.getCreatedAt().toInstant(),
                record.getUpdatedAt().toInstant());
    }
}
