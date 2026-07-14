package com.webuipoc.connect;

import build.buf.protovalidate.Validator;
import build.buf.protovalidate.ValidatorFactory;
import io.grpc.BindableService;
import io.grpc.ServerServiceDefinition;
import io.helidon.webserver.http.HttpFeature;
import io.helidon.webserver.http.HttpRouting;
import java.util.ArrayList;
import java.util.List;

/**
 * Helidon SE routing feature that exposes gRPC services over the Connect
 * protocol (unary RPCs only), so connect-es clients (browser and SSR) can call
 * them without a gRPC transport.
 *
 * <p>Service-agnostic by construction: it accepts any {@link BindableService}
 * or prebuilt {@link ServerServiceDefinition} and routes
 * {@code POST /{package}.{Service}/{Method}} requests to the definition's
 * method handlers via the gRPC method descriptors — no per-method or
 * per-service code. Streaming methods are not exposed (calling one yields a
 * Connect {@code unimplemented} error).
 *
 * <p>Also installs the CORS behavior Connect browser clients need (mirroring
 * the Bun service): an {@code OPTIONS} preflight handler and response headers
 * on every route, per {@link ConnectCors}.
 *
 * <p>Every parsed request message is checked against its protovalidate
 * constraints ({@code buf.validate.*} options in the proto) before dispatch;
 * violations yield a Connect {@code invalid_argument} error. The
 * {@link Validator} is built once here — it is thread-safe and caches
 * compiled rules per message type — and shared by all handlers.
 *
 * <pre>{@code
 * WebServer.builder()
 *         .routing(routing -> routing
 *                 .addFeature(ConnectUnaryFeature.create(new TodoServiceImpl()))
 *                 .get("/health", ...))
 *         .build()
 *         .start();
 * }</pre>
 */
public final class ConnectUnaryFeature implements HttpFeature {

    private final List<ServerServiceDefinition> services;
    private final Validator validator = ValidatorFactory.newBuilder().build();

    private ConnectUnaryFeature(List<ServerServiceDefinition> services) {
        this.services = services;
    }

    /** Creates the feature for the given services. */
    public static ConnectUnaryFeature create(BindableService... services) {
        List<ServerServiceDefinition> definitions = new ArrayList<>();
        for (BindableService service : services) {
            definitions.add(service.bindService());
        }
        return new ConnectUnaryFeature(definitions);
    }

    /** Creates the feature for the given service definitions. */
    public static ConnectUnaryFeature create(ServerServiceDefinition... services) {
        return new ConnectUnaryFeature(List.of(services));
    }

    @Override
    public void setup(HttpRouting.Builder routing) {
        routing.addFilter(ConnectCors.filter());
        routing.options("/*", ConnectCors.preflightHandler());
        for (ServerServiceDefinition service : services) {
            String serviceName = service.getServiceDescriptor().getName();
            ConnectUnaryHandler handler = new ConnectUnaryHandler(service, validator);
            // POST serves every unary method; GET serves only NO_SIDE_EFFECTS
            // methods (the handler rejects GET to a non-safe method with 405).
            // The connect-es client issues GET for idempotency_level =
            // NO_SIDE_EFFECTS RPCs when useHttpGet is enabled.
            routing.post("/" + serviceName + "/*", handler);
            routing.get("/" + serviceName + "/*", handler);
        }
    }
}
