package com.webuipoc.businesslogic.todo;

import javax.sql.DataSource;
import org.flywaydb.core.Flyway;

/**
 * PostgreSQL bootstrap: owns the pooled {@link DataSource} handed to it and runs
 * the Flyway migrations to their latest version <em>before</em> the process
 * starts serving traffic.
 *
 * <p>The bean graph builds {@link TodoDb} during {@code BeanScope.build()} (see
 * {@code Main}), which happens before {@code WebServer.start()} — so schema
 * migration is complete by the time the first RPC can arrive. Migrations live at
 * {@code classpath:db/migration} (see {@code src/main/resources/db/migration});
 * V1 is the baseline {@code todos} table translated from the retired SQLite
 * schema.
 *
 * <p>The {@link DataSource} is a HikariCP pool (built in {@code AppFactory}); it
 * is {@code AutoCloseable} and closed by the DI scope on shutdown, so
 * {@link TodoDb} does not own the connection lifecycle — {@link TodoRepository}'s
 * jOOQ {@code DSLContext} borrows a pooled connection per statement via
 * {@link #dataSource()} and returns it to the pool.
 */
public final class TodoDb {

    private final DataSource dataSource;

    /**
     * Wraps the pooled {@code dataSource} and migrates the schema to its latest
     * version. Flyway needs the {@code flyway-database-postgresql} module on the
     * classpath (a separate artifact since Flyway 10) to recognise the
     * {@code jdbc:postgresql:} URL; both it and {@code flyway-core} are runtime
     * dependencies of this module.
     */
    public TodoDb(DataSource dataSource) {
        this.dataSource = dataSource;
        Flyway.configure()
                .dataSource(dataSource)
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    /**
     * The migrated, pooled {@link DataSource} — for {@link TodoRepository}'s
     * jOOQ {@code DSLContext}, which borrows/returns a pooled connection per
     * statement through it. Package-private on purpose: obtaining the
     * datasource through {@code TodoDb} (never injecting it directly) keeps
     * "schema is migrated before first use" true by construction.
     */
    DataSource dataSource() {
        return dataSource;
    }
}
