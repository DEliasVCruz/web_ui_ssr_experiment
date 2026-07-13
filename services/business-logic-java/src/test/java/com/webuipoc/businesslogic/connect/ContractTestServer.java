package com.webuipoc.businesslogic.connect;

import io.helidon.webserver.WebServer;

/**
 * Manual entry point for the cross-client contract test
 * ({@code scripts/connect-contract-test.ts}): serves {@link StubTodoService}
 * through the Connect adapter so a real connect-es client can call it.
 *
 * <p>Run from the repo root (inside devenv):
 *
 * <pre>
 * mvn -q -f services/business-logic-java test-compile exec:java \
 *     -DmainClass=com.webuipoc.businesslogic.connect.ContractTestServer \
 *     -Dexec.classpathScope=test
 * </pre>
 *
 * <p>(The pom wires exec-maven-plugin's {@code mainClass} to the
 * {@code mainClass} Maven property, so it is overridden with
 * {@code -DmainClass=...}, not {@code -Dexec.mainClass=...}.)
 */
public final class ContractTestServer {

    private static final int DEFAULT_PORT = 3911;

    private ContractTestServer() {
    }

    public static void main(String[] args) {
        String portEnv = System.getenv("PORT");
        int port = portEnv == null || portEnv.isBlank() ? DEFAULT_PORT : Integer.parseInt(portEnv.trim());
        WebServer server = WebServer.builder()
                .port(port)
                .routing(routing -> routing.addFeature(ConnectUnaryFeature.create(new StubTodoService())))
                .build()
                .start();
        System.out.println("connect contract-test server (StubTodoService) listening on http://localhost:"
                + server.port());
    }
}
