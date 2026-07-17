package com.webuipoc.businesslogic.todo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.OffsetDateTime;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Verifies the PostgreSQL bootstrap: Flyway runs the V1 baseline, and the
 * migrated {@code todos} table has the honestly-translated column types
 * (boolean {@code completed}, timestamptz timestamps, case-sensitive text id).
 */
class TodoDbTest {

    @BeforeEach
    void reset() {
        PostgresSupport.reset();
    }

    @Test
    void flywayRecordsTheV1Baseline() throws Exception {
        // Constructing PostgresSupport.todoDb() already ran migrate(); the history
        // table proves Flyway executed the V1 baseline successfully.
        try (Connection connection = PostgresSupport.dataSource().getConnection();
                Statement statement = connection.createStatement();
                ResultSet rs = statement.executeQuery(
                        "SELECT version, success FROM flyway_schema_history WHERE version = '1'")) {
            assertTrue(rs.next(), "V1 migration should be recorded in flyway_schema_history");
            assertEquals("1", rs.getString("version"));
            assertTrue(rs.getBoolean("success"), "V1 migration should have succeeded");
        }
    }

    @Test
    void columnDefaultsMatchTheMigration() throws Exception {
        // Insert relying on the DDL defaults only: completed -> false, timestamps -> now().
        try (Connection connection = PostgresSupport.dataSource().getConnection();
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO todos (id, title) VALUES ('defaults', 'uses ddl defaults')");
            try (ResultSet rs = statement.executeQuery(
                    "SELECT completed, created_at, updated_at FROM todos WHERE id = 'defaults'")) {
                assertTrue(rs.next());
                assertFalse(rs.getBoolean("completed"), "completed must default to false");
                assertNotNull(rs.getObject("created_at", OffsetDateTime.class), "created_at must default to now()");
                assertNotNull(rs.getObject("updated_at", OffsetDateTime.class), "updated_at must default to now()");
            }
        }
    }

    @Test
    void idIsCaseSensitiveText() throws Exception {
        // The deliberate text-not-uuid choice: exact, case-sensitive matching, so
        // an upper-cased id does NOT match a lower-cased row (pinned by MainTest's
        // "uppercase UUID misses at the repo layer" boundary).
        try (Connection connection = PostgresSupport.dataSource().getConnection();
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO todos (id, title, completed) VALUES ('abc', 'lower', true)");
            try (ResultSet rs = statement.executeQuery("SELECT id FROM todos WHERE id = 'ABC'")) {
                assertFalse(rs.next(), "text id is case-sensitive: 'ABC' must not match stored 'abc'");
            }
            try (ResultSet rs = statement.executeQuery("SELECT completed FROM todos WHERE id = 'abc'")) {
                assertTrue(rs.next());
                assertTrue(rs.getBoolean("completed"), "completed is a real boolean column");
            }
        }
    }
}
