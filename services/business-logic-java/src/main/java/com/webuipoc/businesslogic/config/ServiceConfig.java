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
 * {@code WebServer.builder()}, and {@code AppFactory} feeds {@link #databasePath()}
 * into the SQLite {@code TodoDb}.
 *
 * <p>Keys and their historical env-var overrides:
 * <ul>
 *   <li>{@code server.port} (env {@code PORT}, default {@code 3001})</li>
 *   <li>{@code db.path} (env {@code DATABASE_PATH}, default {@code ./data/todos.db})</li>
 * </ul>
 * The defaults passed here match {@code application.yaml}; avaje-config applies
 * the file value (and any system-property / env-var override) ahead of them, so
 * these code-level defaults only apply if the resource is entirely absent.
 */
public record ServiceConfig(int serverPort, String databasePath) {

    /** Config key for the Helidon WebServer listen port. */
    public static final String KEY_SERVER_PORT = "server.port";
    /** Config key for the SQLite database file path. */
    public static final String KEY_DB_PATH = "db.path";

    static final int DEFAULT_SERVER_PORT = 3001;
    static final String DEFAULT_DB_PATH = "./data/todos.db";

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
                configuration.get(KEY_DB_PATH, DEFAULT_DB_PATH));
    }
}
