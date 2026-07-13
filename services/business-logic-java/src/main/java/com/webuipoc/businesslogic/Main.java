package com.webuipoc.businesslogic;

import io.helidon.common.media.type.MediaTypes;
import io.helidon.webserver.WebServer;
import io.helidon.webserver.http.HttpRouting;

/**
 * Entry point for the business-logic-java service (Helidon SE).
 *
 * <p>Scaffold only: serves {@code GET /health} with the same JSON shape as the
 * Bun service ({@code services/business-logic/src/app.ts}). The TodoService
 * gRPC implementation lands in a later task; its generated stubs
 * ({@code todo.v1.TodoServiceGrpc}) already compile as part of this build.
 */
public final class Main {

    static final int DEFAULT_PORT = 3001;
    static final String HEALTH_JSON = "{\"status\":\"ok\"}";

    private Main() {
    }

    public static void main(String[] args) {
        WebServer server = WebServer.builder()
                .port(resolvePort(System.getenv("PORT")))
                .routing(Main::routing)
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

    static void routing(HttpRouting.Builder routing) {
        routing.get("/health", (req, res) -> {
            res.headers().contentType(MediaTypes.APPLICATION_JSON);
            res.send(HEALTH_JSON);
        });
    }
}
