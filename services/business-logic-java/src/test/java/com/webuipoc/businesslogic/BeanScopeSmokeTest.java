package com.webuipoc.businesslogic;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;

import com.webuipoc.businesslogic.mapper.TodoMapper;
import com.webuipoc.businesslogic.todo.PostgresSupport;
import com.webuipoc.businesslogic.todo.TodoDb;
import com.webuipoc.businesslogic.todo.TodoGrpcBridge;
import com.webuipoc.businesslogic.todo.TodoService;
import com.zaxxer.hikari.HikariDataSource;
import io.avaje.inject.BeanScope;
import io.avaje.validation.Validator;
import org.junit.jupiter.api.Test;

/**
 * Smoke test for the avaje-inject wiring: the whole bean graph builds and the
 * gRPC bridge (plus its transitive collaborators) is resolvable.
 *
 * <p>The shared test container's {@link HikariDataSource} and already-migrated
 * {@link TodoDb} are supplied to the scope, so the generated factory skips its
 * own {@code dataSource()} / {@code todoDb()} beans ({@code isBeanAbsent} guards)
 * and never tries to connect to the default {@code localhost:5432} URL.
 */
class BeanScopeSmokeTest {

    @Test
    void scopeBuildsAndBridgeIsResolvable() {
        try (BeanScope scope = BeanScope.builder()
                .bean(HikariDataSource.class, PostgresSupport.dataSource())
                .bean(TodoDb.class, PostgresSupport.todoDb())
                .build()) {
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
