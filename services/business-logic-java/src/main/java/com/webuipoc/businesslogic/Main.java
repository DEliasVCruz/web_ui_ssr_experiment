package com.webuipoc.businesslogic;

import com.webuipoc.businesslogic.config.ServiceConfig;
import com.webuipoc.businesslogic.todo.TodoDb;
import com.webuipoc.businesslogic.todo.TodoGrpcBridge;
import com.webuipoc.connect.ConnectUnaryFeature;
import com.webuipoc.connect.WideEventFeature;
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

    /**
     * The {@code component} tag on every wide-event log line (task iq2.1): this
     * service's identity. Supplied to the service-agnostic adapter's
     * {@link WideEventFeature} from the composition root rather than hardcoded in
     * the adapter, so the adapter stays reusable.
     */
    static final String WIDE_EVENT_COMPONENT = "business-logic-java";

    private Main() {}

    public static void main(String[] args) {
        WebServer server = start();
        System.out.println("business-logic-java listening on http://localhost:" + server.port());
    }

    /**
     * Boots the full service: builds the compile-time DI graph (which runs the
     * Flyway migrations in the {@code TodoDb} constructor) and starts the Helidon
     * {@code WebServer} on the configured port, returning the started server.
     *
     * <p>Package-private composition seam for the integration tests: they set the
     * public env-var contract ({@code PORT=0}, {@code DATABASE_URL} etc.) as
     * system properties pointing at a Testcontainers Postgres and then boot the
     * <em>real</em> service through this method — no test-only wiring, the exact
     * path {@link #main} takes. The {@code shutdownHook(true)} scope closes the
     * bean graph (and the HikariCP pool) on JVM exit, so callers keep only the
     * {@code WebServer} handle (to read its ephemeral port and to {@code stop()} it).
     */
    // PMD.CloseResource: the BeanScope is intentionally NOT closed here — it is a
    // process-lifetime resource whose shutdownHook(true) registers a JVM shutdown hook
    // that closes it (and the HikariCP pool) on exit; callers keep only the WebServer
    // handle. The rule stays active everywhere else (notably the JDBC persistence
    // layer), so this single documented carve-out does not weaken resource-leak
    // detection elsewhere.
    @SuppressWarnings("PMD.CloseResource")
    static WebServer start() {
        // Compile-time DI graph; building it runs Flyway migrations (TodoDb ctor).
        // shutdownHook(true) closes the scope (and the HikariCP pool) on JVM shutdown.
        BeanScope scope = BeanScope.builder().shutdownHook(true).build();
        TodoGrpcBridge bridge = scope.get(TodoGrpcBridge.class);
        // The avaje-config -> Helidon bridge: the server port is resolved by
        // avaje-config (application.yaml default 3001, env override PORT) and
        // fed explicitly into the Helidon WebServer builder. Helidon SE never
        // reads avaje-config directly — this is the only crossing point.
        ServiceConfig config = scope.get(ServiceConfig.class);
        return WebServer.builder()
                .port(config.serverPort())
                .routing(routing -> routing(routing, bridge))
                .build()
                .start();
    }

    /** The production routing: Connect adapter over {@code todoService} + {@code GET /health}. */
    static void routing(HttpRouting.Builder routing, BindableService todoService) {
        // Wide-event request logging (task iq2.1): one structured JSON line per
        // request to stdout. Registration ORDER here is irrelevant — Helidon
        // weight-sorts features at routing build() — what makes this filter
        // outermost (wrapping the Connect adapter + /health) is the feature's
        // Weighted weight of 1000 (see WideEventFeature).
        routing.addFeature(WideEventFeature.create(WIDE_EVENT_COMPONENT));
        routing.addFeature(ConnectUnaryFeature.create(todoService));
        routing.get("/health", (req, res) -> {
            res.headers().contentType(MediaTypes.APPLICATION_JSON);
            res.send(HEALTH_JSON);
        });
    }
}
