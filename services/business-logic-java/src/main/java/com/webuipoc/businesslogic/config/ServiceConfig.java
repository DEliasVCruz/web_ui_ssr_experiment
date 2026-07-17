package com.webuipoc.businesslogic.config;

import io.avaje.config.Configuration;

/**
 * Typed, immutable holder for the business-logic-java service's configuration.
 *
 * <p>This is the single place the rest of the app reads service configuration
 * from — no {@code System.getenv} / {@code Config.getX} calls sprinkled through
 * business code. It is produced from an avaje-config {@link Configuration} (see
 * {@code AppFactory#serviceConfig()} which builds it from the global
 * {@code Config.asConfiguration()}), and injected where needed:
 * {@code Main} bridges {@link #serverPort()} into the Helidon
 * {@code WebServer.builder()}, and {@code AppFactory} feeds the datasource
 * settings into the HikariCP pool.
 *
 * <p>Keys and their historical env-var overrides:
 * <ul>
 *   <li>{@code server.port} (env {@code PORT}, default {@code 3001})</li>
 *   <li>{@code db.url} (env {@code DATABASE_URL}, default
 *       {@code jdbc:postgresql://localhost:5432/todos})</li>
 *   <li>{@code db.username} (env {@code DATABASE_USERNAME}, default {@code todos})</li>
 *   <li>{@code db.password} (env {@code DATABASE_PASSWORD}, default empty — secrets
 *       stay in the environment, never in a committed file)</li>
 *   <li>{@code db.pool.max-size} (env {@code DB_POOL_MAX_SIZE}, default {@code 16})</li>
 *   <li>{@code db.pool.min-idle} (env {@code DB_POOL_MIN_IDLE}, default {@code 4})</li>
 * </ul>
 * The defaults passed here match {@code application.yaml}; avaje-config applies
 * the file value (and any system-property / env-var override) ahead of them, so
 * these code-level defaults only apply if the resource is entirely absent.
 */
public record ServiceConfig(
        int serverPort, String dbUrl, String dbUsername, String dbPassword, int dbPoolMaxSize, int dbPoolMinIdle) {

    /** Config key for the Helidon WebServer listen port. */
    public static final String KEY_SERVER_PORT = "server.port";
    /** Config key for the JDBC URL of the PostgreSQL database. */
    public static final String KEY_DB_URL = "db.url";
    /** Config key for the database username. */
    public static final String KEY_DB_USERNAME = "db.username";
    /** Config key for the database password (env-supplied; empty default). */
    public static final String KEY_DB_PASSWORD = "db.password";
    /** Config key for the HikariCP maximum pool size. */
    public static final String KEY_DB_POOL_MAX_SIZE = "db.pool.max-size";
    /** Config key for the HikariCP minimum idle connections. */
    public static final String KEY_DB_POOL_MIN_IDLE = "db.pool.min-idle";

    static final int DEFAULT_SERVER_PORT = 3001;
    static final String DEFAULT_DB_URL = "jdbc:postgresql://localhost:5432/todos";
    static final String DEFAULT_DB_USERNAME = "todos";
    static final String DEFAULT_DB_PASSWORD = "";
    // Lean pool: sized for the DB's connection budget, NOT for the virtual-thread
    // request count. 16 max / 4 idle is plenty for a single todo service.
    static final int DEFAULT_DB_POOL_MAX_SIZE = 16;
    static final int DEFAULT_DB_POOL_MIN_IDLE = 4;

    /**
     * Reads the typed configuration out of the supplied avaje-config
     * {@link Configuration}. Kept side-effect free and Configuration-parameterised
     * (rather than reaching for the global {@code Config}) so it is trivially
     * unit-testable against isolated Configuration instances.
     *
     * <p>Invalid-port semantics (deliberate, pinned by ServiceConfigTest):
     * a non-numeric {@code server.port} / {@code PORT} value FAILS FAST — this
     * {@code getInt} propagates {@link NumberFormatException} and the process
     * never starts. The retired Bun service silently fell back to 3001; that
     * leniency was intentionally dropped: config errors should be loud, not
     * masked by a default. {@code PORT=0} is passed through to Helidon, which
     * binds an OS-assigned ephemeral port.
     */
    public static ServiceConfig from(Configuration configuration) {
        return new ServiceConfig(
                configuration.getInt(KEY_SERVER_PORT, DEFAULT_SERVER_PORT),
                configuration.get(KEY_DB_URL, DEFAULT_DB_URL),
                configuration.get(KEY_DB_USERNAME, DEFAULT_DB_USERNAME),
                configuration.get(KEY_DB_PASSWORD, DEFAULT_DB_PASSWORD),
                configuration.getInt(KEY_DB_POOL_MAX_SIZE, DEFAULT_DB_POOL_MAX_SIZE),
                configuration.getInt(KEY_DB_POOL_MIN_IDLE, DEFAULT_DB_POOL_MIN_IDLE));
    }
}
