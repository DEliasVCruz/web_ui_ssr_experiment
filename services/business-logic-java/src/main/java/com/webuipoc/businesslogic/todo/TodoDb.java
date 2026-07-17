package com.webuipoc.businesslogic.todo;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * SQLite bootstrap, a port of the Bun service's {@code src/db.ts}: same
 * default path, same PRAGMAs, and the exact same {@code todos} DDL.
 */
public final class TodoDb implements AutoCloseable {

    // Copied verbatim from services/business-logic/src/db.ts.
    private static final String CREATE_TODOS_TABLE = """
            CREATE TABLE IF NOT EXISTS todos (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            """;

    private final Connection connection;

    /**
     * Opens (creating if needed) the SQLite database at {@code dbPath},
     * creating missing parent directories first — the Bun service had a bug
     * where a fresh checkout without {@code data/} failed every RPC (fixed in
     * db.ts with {@code mkdirSync(dirname(dbPath), { recursive: true })});
     * this port must not regress it.
     *
     * <p>The path is supplied by the caller ({@code AppFactory} feeds
     * {@code ServiceConfig#databasePath()} here). The default and the historical
     * {@code DATABASE_PATH} env-var override now live in avaje-config
     * (application.yaml), not in this class.
     */
    public TodoDb(String dbPath) {
        Path parent = Path.of(dbPath).getParent();
        if (parent != null) {
            try {
                Files.createDirectories(parent);
            } catch (IOException e) {
                throw new UncheckedIOException("failed to create database directory " + parent, e);
            }
        }
        try {
            connection = DriverManager.getConnection("jdbc:sqlite:" + dbPath);
            try (Statement statement = connection.createStatement()) {
                statement.execute("PRAGMA journal_mode = WAL;");
                statement.execute("PRAGMA foreign_keys = ON;");
                statement.execute(CREATE_TODOS_TABLE);
            }
        } catch (SQLException e) {
            throw new IllegalStateException("failed to open SQLite database at " + dbPath, e);
        }
    }

    Connection connection() {
        return connection;
    }

    @Override
    public void close() {
        try {
            connection.close();
        } catch (SQLException e) {
            throw new IllegalStateException("failed to close SQLite database", e);
        }
    }
}
