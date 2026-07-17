package com.webuipoc.businesslogic.todo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TodoDbTest {

    /** The exact string shape Bun's repository writes: new Date().toISOString(). */
    static final Pattern BUN_ISO_MILLIS = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");

    @Test
    void createsMissingParentDirectories(@TempDir Path tempDir) throws Exception {
        // DATABASE_PATH pointing into a directory that does not exist yet — the
        // Bun service regression fixed in db.ts (commit c221ef9).
        Path dbPath = tempDir.resolve("does").resolve("not").resolve("exist").resolve("todos.db");
        assertTrue(Files.notExists(dbPath.getParent()));

        try (TodoDb db = new TodoDb(dbPath.toString())) {
            assertTrue(Files.exists(dbPath), "database file should have been created");
            // And it is actually usable end to end.
            TodoRepository repository = new TodoRepository(db);
            assertNotNull(repository.createTodo("created in fresh dir"));
            assertEquals(1, repository.listTodos().size());
        }
    }

    @Test
    void appliesWalAndForeignKeysPragmas(@TempDir Path tempDir) throws Exception {
        try (TodoDb db = new TodoDb(tempDir.resolve("todos.db").toString());
                Statement statement = db.connection().createStatement()) {
            try (ResultSet rs = statement.executeQuery("PRAGMA journal_mode")) {
                assertTrue(rs.next());
                assertEquals("wal", rs.getString(1));
            }
            try (ResultSet rs = statement.executeQuery("PRAGMA foreign_keys")) {
                assertTrue(rs.next());
                assertEquals(1, rs.getInt(1));
            }
        }
    }

    @Test
    void schemaColumnDefaultsMatchBunDdl(@TempDir Path tempDir) throws Exception {
        // Insert relying on the DDL defaults only; the strftime default must
        // produce the same millisecond-precision Zulu format as the Bun DDL.
        try (TodoDb db = new TodoDb(tempDir.resolve("todos.db").toString());
                Statement statement = db.connection().createStatement()) {
            statement.execute("INSERT INTO todos (id, title) VALUES ('x', 'defaults')");
            try (ResultSet rs =
                    statement.executeQuery("SELECT completed, created_at, updated_at FROM todos WHERE id = 'x'")) {
                assertTrue(rs.next());
                assertEquals(0, rs.getInt("completed"));
                assertTrue(BUN_ISO_MILLIS.matcher(rs.getString("created_at")).matches());
                assertTrue(BUN_ISO_MILLIS.matcher(rs.getString("updated_at")).matches());
            }
        }
    }
}
