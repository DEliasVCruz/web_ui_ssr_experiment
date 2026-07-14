package com.webuipoc.connect;

import io.helidon.http.HeaderName;
import io.helidon.http.HeaderNames;
import io.helidon.http.Status;
import io.helidon.webserver.http.Filter;
import io.helidon.webserver.http.Handler;
import java.util.List;

/**
 * CORS behavior for Connect clients, mirroring the Bun service
 * ({@code services/business-logic/src/app.ts}: hono/cors configured with the
 * {@code cors} constants exported by {@code @connectrpc/connect}).
 *
 * <p>The allowed/exposed header lists below are a verbatim transcription of
 * {@code cors.allowedMethods}, {@code cors.allowedHeaders} and
 * {@code cors.exposedHeaders} from connect-es 2.1.2
 * ({@code @connectrpc/connect/dist/esm/cors.js}), with the header-name
 * constants resolved from {@code protocol-connect/headers.js},
 * {@code protocol-grpc/headers.js} and {@code protocol-grpc-web/headers.js}.
 */
final class ConnectCors {

    static final String ALLOW_ORIGIN = "*";

    /** connect-es {@code cors.allowedMethods}. */
    static final List<String> ALLOWED_METHODS = List.of("POST", "GET");

    /** connect-es {@code cors.allowedHeaders}. */
    static final List<String> ALLOWED_HEADERS = List.of(
            "Content-Type",
            "Connect-Protocol-Version",
            "Connect-Timeout-Ms",
            "Connect-Content-Encoding",
            "Connect-Accept-Encoding",
            "Content-Encoding",
            "Accept-Encoding",
            "Grpc-Message-Type",
            "X-Grpc-Web",
            "X-User-Agent",
            "Grpc-Timeout");

    /** connect-es {@code cors.exposedHeaders}. */
    static final List<String> EXPOSED_HEADERS = List.of(
            "Grpc-Status",
            "Grpc-Message",
            "Grpc-Status-Details-Bin",
            "Content-Encoding",
            "Connect-Content-Encoding");

    private static final HeaderName ALLOW_ORIGIN_HEADER = HeaderNames.create("Access-Control-Allow-Origin");
    private static final HeaderName ALLOW_METHODS_HEADER = HeaderNames.create("Access-Control-Allow-Methods");
    private static final HeaderName ALLOW_HEADERS_HEADER = HeaderNames.create("Access-Control-Allow-Headers");
    private static final HeaderName EXPOSE_HEADERS_HEADER = HeaderNames.create("Access-Control-Expose-Headers");

    private ConnectCors() {
    }

    /**
     * Filter applied to every request (like the Bun service's {@code app.use("/*", cors(...))}):
     * adds {@code Access-Control-Allow-Origin} and {@code Access-Control-Expose-Headers}
     * to all responses, including routing errors.
     */
    static Filter filter() {
        String exposed = String.join(",", EXPOSED_HEADERS);
        return (chain, req, res) -> {
            res.header(ALLOW_ORIGIN_HEADER, ALLOW_ORIGIN);
            res.header(EXPOSE_HEADERS_HEADER, exposed);
            chain.proceed();
        };
    }

    /** Handler for {@code OPTIONS} preflight requests: 204 with the CORS allow-lists. */
    static Handler preflightHandler() {
        String methods = String.join(",", ALLOWED_METHODS);
        String headers = String.join(",", ALLOWED_HEADERS);
        return (req, res) -> {
            res.header(ALLOW_METHODS_HEADER, methods);
            res.header(ALLOW_HEADERS_HEADER, headers);
            res.status(Status.NO_CONTENT_204).send();
        };
    }
}
