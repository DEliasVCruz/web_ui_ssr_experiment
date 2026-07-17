package com.webuipoc.connect;

import io.helidon.webserver.http.ServerRequest;

/**
 * Thin enrichment seam between the Connect handler and the {@link WideEvent}
 * registered for the current request by {@link WideEventFilter}.
 *
 * <p>The event lives in the Helidon request {@link io.helidon.common.context.Context}
 * (safe: Helidon SE runs the whole request on a single virtual thread). Callers
 * add fields where the information is naturally available — the handler knows the
 * RPC method and the Connect outcome code — without holding a reference to the
 * event or knowing whether logging is even enabled: if no event is registered
 * (e.g. a plain HTTP route, or tests without the filter) every method is a no-op.
 * This keeps the coupling one-directional and optional.
 */
final class WideEvents {

    private WideEvents() {}

    /** Records the fully-qualified RPC method (e.g. {@code todo.v1.TodoService/GetTodo}). */
    static void rpcMethod(ServerRequest request, String rpcMethod) {
        request.context().get(WideEvent.class).ifPresent(event -> event.setRpcMethod(rpcMethod));
    }

    /** Records the Connect wire error code (e.g. {@code not_found}) on a failed request. */
    static void connectCode(ServerRequest request, String connectCode) {
        request.context().get(WideEvent.class).ifPresent(event -> event.setConnectCode(connectCode));
    }
}
