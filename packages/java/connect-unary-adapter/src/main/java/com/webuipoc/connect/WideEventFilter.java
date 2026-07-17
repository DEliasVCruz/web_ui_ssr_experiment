package com.webuipoc.connect;

import io.avaje.jsonb.JsonType;
import io.avaje.jsonb.Jsonb;
import io.helidon.http.HeaderName;
import io.helidon.http.HeaderNames;
import io.helidon.webserver.http.Filter;
import io.helidon.webserver.http.FilterChain;
import io.helidon.webserver.http.RoutingRequest;
import io.helidon.webserver.http.RoutingResponse;
import java.io.PrintStream;
import java.time.Instant;

/**
 * Helidon filter that emits exactly one {@link WideEvent} JSON line to a
 * {@link PrintStream} (stdout in production) at the completion of every request —
 * the wide-event request-logging pattern.
 *
 * <p><b>Placement and lifecycle.</b> Installed by {@link WideEventFeature} at a
 * weight that runs it before routing, so it wraps the whole request. On entry it
 * resolves the {@link TraceContext} from the inbound {@code traceparent} header,
 * seeds the trace/HTTP fields and registers the event in the request
 * {@link io.helidon.common.context.Context} (so the Connect handler can enrich it
 * via {@link WideEvents}); it then proceeds down the chain inside a
 * {@code try/finally}. The event is emitted in the {@code finally} block, so it
 * fires on <em>every</em> outcome — success, Connect error, or a thrown exception
 * — with {@code duration_ms} measured from filter entry and {@code status} read
 * from the final response. Helidon's routing catches handler exceptions and turns
 * them into a response before {@code proceed()} returns (so {@code status} is
 * accurate for those); if {@code proceed()} itself throws (e.g. a connection
 * close), the throwable is projected onto the event's {@code error} and rethrown,
 * and the event is still emitted.
 *
 * <p><b>Codec.</b> The event is serialized with avaje-jsonb — a compile-time,
 * reflection-free codec. {@code serializeNulls(true)} keeps every nullable schema
 * key present (a stable shape for downstream consumers). The {@link Jsonb} and its
 * {@link JsonType} are built once and are thread-safe.
 */
public final class WideEventFilter implements Filter {

    private static final HeaderName TRACEPARENT = HeaderNames.create("traceparent");
    private static final long NANOS_PER_MILLI = 1_000_000L;

    private final String component;
    private final PrintStream out;
    private final JsonType<WideEvent> eventType;

    WideEventFilter(String component, PrintStream out) {
        this.component = component;
        this.out = out;
        Jsonb jsonb = Jsonb.builder().serializeNulls(true).build();
        this.eventType = jsonb.type(WideEvent.class);
    }

    @Override
    public void filter(FilterChain chain, RoutingRequest req, RoutingResponse res) {
        long startNanos = System.nanoTime();

        WideEvent event = new WideEvent();
        TraceContext trace =
                TraceContext.resolve(req.headers().first(TRACEPARENT).orElse(null));
        event.setTraceId(trace.traceId());
        event.setSpanId(trace.spanId());
        event.setParentSpanId(trace.parentSpanId());
        event.setComponent(component);
        event.setHttpMethod(req.prologue().method().text());
        event.setPath(req.prologue().uriPath().path());
        req.context().register(event);

        try {
            chain.proceed();
        } catch (RuntimeException | Error t) {
            // Routing normally converts handler failures into a response before
            // proceed() returns; reaching here means proceed() itself threw
            // (e.g. CloseConnectionException / UncheckedIOException). Record it and
            // rethrow so Helidon's connection handling is unchanged — the finally
            // still emits the event.
            event.setError(WideEventError.from(t));
            throw t;
        } finally {
            event.setDurationMs((System.nanoTime() - startNanos) / NANOS_PER_MILLI);
            event.setTimestamp(Instant.now().toString());
            event.setStatus(res.status().code());
            out.println(eventType.toJson(event));
        }
    }
}
