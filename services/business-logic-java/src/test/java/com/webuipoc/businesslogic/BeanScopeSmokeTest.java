package com.webuipoc.businesslogic;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;

import com.webuipoc.businesslogic.mapper.TodoMapper;
import com.webuipoc.businesslogic.todo.TodoDb;
import com.webuipoc.businesslogic.todo.TodoGrpcBridge;
import com.webuipoc.businesslogic.todo.TodoService;
import io.avaje.inject.BeanScope;
import io.avaje.validation.Validator;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Smoke test for the avaje-inject wiring: the whole bean graph builds and the
 * gRPC bridge (plus its transitive collaborators) is resolvable. A temp-file
 * {@link TodoDb} is supplied to the scope so the test does not touch the default
 * {@code ./data/todos.db} (the generated factory skips its own TodoDb bean when
 * one is already supplied — {@code isBeanAbsent} guard).
 */
class BeanScopeSmokeTest {

    @TempDir
    Path tempDir;

    @Test
    void scopeBuildsAndBridgeIsResolvable() {
        try (TodoDb db = new TodoDb(tempDir.resolve("todos.db").toString());
                BeanScope scope = BeanScope.builder().bean(TodoDb.class, db).build()) {
            TodoGrpcBridge bridge = scope.get(TodoGrpcBridge.class);
            assertNotNull(bridge, "bridge should be resolvable from the scope");

            // The rest of the graph is present too.
            assertNotNull(scope.get(TodoService.class));
            assertNotNull(scope.get(TodoMapper.class));
            assertNotNull(scope.get(Validator.class));

            // Singletons: a second get returns the same instance.
            assertSame(bridge, scope.get(TodoGrpcBridge.class));
        }
    }
}
