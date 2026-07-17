package com.webuipoc.businesslogic.todo;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Shared test fixture: ONE PostgreSQL container for the whole test JVM (the
 * Testcontainers "singleton container" pattern), reached through a small HikariCP
 * pool, with the Flyway schema migrated once.
 *
 * <p>Runs on the podman machine wired by devenv (DOCKER_HOST) with the ryuk
 * reaper disabled by env. Because ryuk is off, an explicit JVM shutdown hook
 * closes the pool and {@code stop()}s the container on clean exit — so a normal
 * {@code mvn verify} leaves no leaked container. (A hard-killed JVM cannot run
 * the hook; clean those with {@code podman container prune}.)
 *
 * <p>The container is shared across every DB-touching test class; each test calls
 * {@link #reset()} to start from an empty {@code todos} table (the migrated
 * schema is left intact).
 */
public final class PostgresSupport {

    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
                    DockerImageName.parse("postgres:17-alpine"))
            .withDatabaseName("todos")
            .withUsername("todos")
            .withPassword("todos");

    private static final HikariDataSource DATA_SOURCE;
    private static final TodoDb TODO_DB;

    static {
        POSTGRES.start();
        HikariConfig config = new HikariConfig();
        config.setPoolName("todo-test-pool");
        config.setJdbcUrl(POSTGRES.getJdbcUrl());
        config.setUsername(POSTGRES.getUsername());
        config.setPassword(POSTGRES.getPassword());
        config.setMaximumPoolSize(4);
        config.setMinimumIdle(1);
        DATA_SOURCE = new HikariDataSource(config);
        // Constructing TodoDb runs the Flyway migrations once for the whole JVM.
        TODO_DB = new TodoDb(DATA_SOURCE);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            DATA_SOURCE.close();
            POSTGRES.stop();
        }));
    }

    private PostgresSupport() {}

    /** The shared HikariCP pool against the container. */
    public static HikariDataSource dataSource() {
        return DATA_SOURCE;
    }

    /** The shared, already-migrated {@link TodoDb}. */
    public static TodoDb todoDb() {
        return TODO_DB;
    }

    /** Empties the todos table so each test starts clean (schema stays migrated). */
    public static void reset() {
        try (Connection connection = DATA_SOURCE.getConnection();
                Statement statement = connection.createStatement()) {
            statement.execute("TRUNCATE TABLE todos");
        } catch (SQLException e) {
            throw new IllegalStateException("failed to reset todos table", e);
        }
    }
}
