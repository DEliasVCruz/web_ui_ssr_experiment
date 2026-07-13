package com.webuipoc.businesslogic.connect;

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
            routing.post("/" + serviceName + "/*", new ConnectUnaryHandler(service));
        }
    }
}
