package com.webuipoc.businesslogic;

import com.webuipoc.businesslogic.config.ServiceConfig;
import com.webuipoc.businesslogic.todo.TodoDb;
import com.webuipoc.businesslogic.todo.TodoGrpcBridge;
import com.webuipoc.connect.ConnectUnaryFeature;
import io.avaje.inject.BeanScope;
import io.grpc.BindableService;
import io.helidon.common.media.type.MediaTypes;
import io.helidon.webserver.WebServer;
import io.helidon.webserver.http.HttpRouting;

/**
 * Entry point for the business-logic-java service (Helidon SE).
 *
 * <p>Serves the {@code todo.v1.TodoService} over the Connect protocol
 * (unary, binary + JSON) via {@link ConnectUnaryFeature}, plus
 * {@code GET /health} with the same JSON shape as the retired Bun service.
 *
 * <p>Wiring is compile-time DI (avaje-inject): the {@link BeanScope} builds the
 * bean graph — HikariCP {@code DataSource} &rarr; {@link TodoDb} (runs Flyway on
 * construction, before the server starts) &rarr; {@code TodoRepository} &rarr;
 * {@code TodoService} core &rarr; {@link TodoGrpcBridge} (plus the MapStruct
 * mapper and the avaje validator). A JVM shutdown hook closes the scope, which
 * closes the {@code AutoCloseable} HikariCP pool.
 *
 * <p>Schema migration runs while the scope is being built (in the {@code TodoDb}
 * constructor), which happens before {@code WebServer.start()} below — so the
 * database is at its latest Flyway version before the first RPC can arrive.
 */
public final class Main {

    static final String HEALTH_JSON = "{\"status\":\"ok\"}";

    private Main() {}

    public static void main(String[] args) {
        // Compile-time DI graph; building it runs Flyway migrations (TodoDb ctor).
        // shutdownHook(true) closes the scope (and the HikariCP pool) on JVM shutdown.
        BeanScope scope = BeanScope.builder().shutdownHook(true).build();
        TodoGrpcBridge bridge = scope.get(TodoGrpcBridge.class);
        // The avaje-config -> Helidon bridge: the server port is resolved by
        // avaje-config (application.yaml default 3001, env override PORT) and
        // fed explicitly into the Helidon WebServer builder. Helidon SE never
        // reads avaje-config directly — this is the only crossing point.
        ServiceConfig config = scope.get(ServiceConfig.class);
        WebServer server = WebServer.builder()
                .port(config.serverPort())
                .routing(routing -> routing(routing, bridge))
                .build()
                .start();
        System.out.println("business-logic-java listening on http://localhost:" + server.port());
    }

    /** The production routing: Connect adapter over {@code todoService} + {@code GET /health}. */
    static void routing(HttpRouting.Builder routing, BindableService todoService) {
        routing.addFeature(ConnectUnaryFeature.create(todoService));
        routing.get("/health", (req, res) -> {
            res.headers().contentType(MediaTypes.APPLICATION_JSON);
            res.send(HEALTH_JSON);
        });
    }
}
