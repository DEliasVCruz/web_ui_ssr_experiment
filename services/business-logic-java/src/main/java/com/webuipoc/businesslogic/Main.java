package com.webuipoc.businesslogic;

import com.webuipoc.businesslogic.connect.ConnectUnaryFeature;
import com.webuipoc.businesslogic.todo.TodoDb;
import com.webuipoc.businesslogic.todo.TodoRepository;
import com.webuipoc.businesslogic.todo.TodoServiceImpl;
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
 * <p>Exactly ONE {@link TodoDb} (one SQLite connection) backs the process:
 * SQLite in WAL mode with two connections on the same file from one process
 * risks {@code SQLITE_BUSY}; the Bun service likewise used a single
 * {@code bun:sqlite} Database.
 */
public final class Main {

    static final int DEFAULT_PORT = 3001;
    static final String HEALTH_JSON = "{\"status\":\"ok\"}";

    private Main() {
    }

    public static void main(String[] args) {
        // Single TodoDb for the whole process (env factory: DATABASE_PATH,
        // default ./data/todos.db). Intentionally not closed here — it lives
        // for the lifetime of the server process.
        TodoDb db = TodoDb.open();
        TodoServiceImpl todoService = new TodoServiceImpl(new TodoRepository(db));
        WebServer server = WebServer.builder()
                .port(resolvePort(System.getenv("PORT")))
                .routing(routing -> routing(routing, todoService))
                .build()
                .start();
        System.out.println("business-logic-java listening on http://localhost:" + server.port());
    }

    /** Mirrors the Bun service: {@code Number(process.env.PORT) || 3001}. */
    static int resolvePort(String portEnv) {
        if (portEnv == null || portEnv.isBlank()) {
            return DEFAULT_PORT;
        }
        try {
            int port = Integer.parseInt(portEnv.trim());
            return port > 0 ? port : DEFAULT_PORT;
        } catch (NumberFormatException e) {
            return DEFAULT_PORT;
        }
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
