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
import org.jooq.InsertSetMoreStep;
import org.jooq.SQLDialect;
import org.jooq.impl.DSL;
import org.jspecify.annotations.Nullable;

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
 * {@code org.jooq.exception.DataAccessException} — the same "DB failure surfaces
 * as an unchecked exception" contract the previous IllegalStateException
 * wrapping provided. The gRPC bridge only catches the domain exceptions
 * (ConstraintViolation/NotFound); any other RuntimeException reaches the Connect
 * adapter's {@code Status.fromThrowable} and surfaces as Connect {@code unknown}
 * (HTTP 500) — loud, never silent.
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
 *       race across pooled connections). The one exception is the idempotent
 *       client-id create: on a primary-key conflict {@code ON CONFLICT DO
 *       NOTHING} returns nothing, so a single follow-up SELECT reads the existing
 *       row back — the two run in one transaction (see {@link #createTodo}).</li>
 *   <li>{@code id} is case-sensitive {@code text}: {@code TODOS.ID.eq(id)} is an
 *       exact text comparison, so an upper-cased UUID must still MISS.</li>
 * </ul>
 */
@Singleton
public final class TodoRepository {

    /**
     * One row of the todos table: boolean completed, Instant timestamps (native
     * Postgres types). {@code details} is nullable — {@code null} maps to the
     * table's NULL "no details" state (distinct from an empty string, which is
     * "details explicitly cleared").
     */
    public record TodoRow(
            String id,
            String title,
            boolean completed,
            @Nullable String details,
            Instant createdAt,
            Instant updatedAt) {}

    private final DSLContext dsl;

    public TodoRepository(TodoDb db) {
        this.dsl = DSL.using(db.dataSource(), SQLDialect.POSTGRES);
    }

    public List<TodoRow> listTodos() {
        // id DESC tiebreaker: created_at is millisecond-truncated, so same-ms ties
        // are realistic. SERVER-minted UUIDv7 ids are time-ordered, making id DESC
        // the natural newest-first order within a tied millisecond; CLIENT-supplied
        // ids (idempotent create) carry no such guarantee, so for them the same-ms
        // order is arbitrary — but still deterministic, which is what matters.
        return dsl.selectFrom(TODOS)
                .orderBy(TODOS.CREATED_AT.desc(), TODOS.ID.desc())
                .fetch(TodoRepository::toTodoRow);
    }

    public Optional<TodoRow> getTodo(String id) {
        return dsl.selectFrom(TODOS).where(TODOS.ID.eq(id)).fetchOptional(TodoRepository::toTodoRow);
    }

    /**
     * Creates a todo. When {@code id} is {@code null} the server mints a fresh
     * UUIDv7 (the default path, and the only one the current UI exercises); a
     * freshly minted id cannot collide, so this stays the original
     * single-statement {@code INSERT ... RETURNING} (one round trip) — existing
     * behavior, pinned.
     *
     * <p>When {@code id} is client-supplied the create is <b>idempotent,
     * first-write-wins</b>: this id is the offline mutation queue's replay key
     * (web_ui_ssr_experiment-1w9). If the id already exists — a queued entry
     * re-sent after a crash mid-flush — the insert hits a primary-key conflict,
     * {@code ON CONFLICT (id) DO NOTHING} writes nothing, and we return the
     * EXISTING row unchanged. Any payload difference on the duplicate (a different
     * title on the replay) is deliberately <b>IGNORED</b>: this is honest
     * at-least-once replay (re-sending the identical queued entry is a no-op),
     * NOT an upsert. {@code created_at}/{@code updated_at} therefore also stay as
     * first written, so a replayed create never disturbs newest-first list order.
     *
     * <p>Atomicity: the insert and the conflict-fetch run in ONE transaction so
     * the pair executes on a single connection as one logical unit — the "insert,
     * else read the row that conflicted us" is not split across two pooled
     * connections. A concurrent DELETE of the just-conflicted row between the two
     * statements is out of scope (single-user experiment; documented in
     * todo.proto), and would surface as an {@link IllegalStateException} — which
     * the bridge does not catch, so it reaches the Connect adapter's
     * {@code Status.fromThrowable} and surfaces as Connect {@code unknown}
     * (HTTP 500) — loud, never a silent wrong answer.
     */
    public TodoRow createTodo(@Nullable String id, String title, @Nullable String details) {
        OffsetDateTime now = nowMillis();
        if (id == null) {
            return toTodoRow(insert(dsl, UuidV7.randomUuidV7(), title, details, now)
                    .returning()
                    .fetchSingle());
        }
        return dsl.transactionResult(cfg -> {
            DSLContext txn = cfg.dsl();
            return insert(txn, id, title, details, now)
                    .onConflict(TODOS.ID)
                    .doNothing()
                    .returning()
                    .fetchOptional()
                    .map(TodoRepository::toTodoRow)
                    .orElseGet(() -> txn.selectFrom(TODOS)
                            .where(TODOS.ID.eq(id))
                            .fetchOptional(TodoRepository::toTodoRow)
                            .orElseThrow(() -> new IllegalStateException(
                                    "insert conflicted on id but the existing row was not found: " + id)));
        });
    }

    /**
     * The shared {@code INSERT ... SET} body for a create, ready for either
     * {@code .returning()} (mint path) or {@code .onConflict(...)} (idempotent
     * client-id path). {@code details} is bound as-is: null -&gt; the column's NULL
     * "no details" state, a non-null value (including "") -&gt; stored verbatim. The
     * column has no default, so an omitted set would also yield NULL; setting it
     * explicitly keeps the create statement symmetric with title.
     */
    private static InsertSetMoreStep<TodosRecord> insert(
            DSLContext ctx, String id, String title, @Nullable String details, OffsetDateTime now) {
        return ctx.insertInto(TODOS)
                .set(TODOS.ID, id)
                .set(TODOS.TITLE, title)
                .set(TODOS.COMPLETED, false)
                .set(TODOS.DETAILS, details)
                .set(TODOS.CREATED_AT, now)
                .set(TODOS.UPDATED_AT, now);
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
     *
     * <p>{@code details} participates in the same presence-based partial update:
     * a {@code null} param leaves the column untouched, while a non-null value —
     * including the empty string — is written through ({@code coalesce("", column)}
     * yields {@code ""}), which is how an update clears the details.
     */
    public Optional<TodoRow> updateTodo(
            String id, @Nullable String title, @Nullable String details, @Nullable Boolean completed) {
        return dsl.update(TODOS)
                .set(TODOS.TITLE, DSL.coalesce(DSL.val(title, TODOS.TITLE), TODOS.TITLE))
                .set(TODOS.DETAILS, DSL.coalesce(DSL.val(details, TODOS.DETAILS), TODOS.DETAILS))
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
                record.getDetails(),
                record.getCreatedAt().toInstant(),
                record.getUpdatedAt().toInstant());
    }
}
