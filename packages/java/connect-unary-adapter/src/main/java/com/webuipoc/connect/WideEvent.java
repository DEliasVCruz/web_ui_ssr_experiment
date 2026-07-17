package com.webuipoc.connect;

import io.avaje.jsonb.Json;
import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * One rich structured event per HTTP request — the "wide event" pattern: instead
 * of many thin log lines, the server emits exactly one JSON object at request
 * completion that carries everything known about the request (trace context,
 * timing, HTTP + Connect outcome, the RPC method, and any error).
 *
 * <p><b>Shared field schema.</b> This type is the canonical definition of the
 * wide-event schema; the TypeScript service mirrors it (see
 * {@code docs/wide-events.md}). Serialized with avaje-jsonb using
 * {@link Json.Naming#LowerUnderscore} so Java camelCase fields become snake_case
 * JSON keys ({@code traceId} &rarr; {@code trace_id}). The {@link WideEventFilter}
 * builds it with {@code serializeNulls(true)}, so the nullable keys
 * ({@code parent_span_id}, {@code connect_code}, {@code rpc_method}, {@code error})
 * are always present, keeping the schema stable for downstream consumers.
 *
 * <p><b>Lifecycle.</b> The filter constructs the event, seeds the trace/HTTP
 * fields and registers it in the Helidon request {@link io.helidon.common.context.Context}
 * before the chain proceeds; the Connect handler enriches it (rpc method, connect
 * code) via {@link WideEvents} where that information is naturally available;
 * the filter fills timing + final status and emits it in its completion path.
 * Mutable by design (single-threaded per request on one virtual thread), hence
 * plain getters/setters rather than a record.
 */
@Json(naming = Json.Naming.LowerUnderscore)
public final class WideEvent {

    // W3C trace context. trace_id/span_id are always set; parent_span_id is null
    // when there was no valid inbound traceparent (this request starts the trace).
    private String traceId = "";
    private String spanId = "";
    private @Nullable String parentSpanId;

    // Timing. timestamp is ISO-8601 at completion; duration_ms is measured from
    // filter entry (whole-request wall time).
    private String timestamp = "";
    private long durationMs;

    // HTTP.
    private String httpMethod = "";
    private String path = "";
    private int status;

    // Connect / RPC outcome. Both null for non-RPC requests (e.g. /health) and
    // connect_code is null for a successful RPC.
    private @Nullable String connectCode;
    private @Nullable String rpcMethod;

    // Provenance: which service emitted the event (injected, not hardcoded, so the
    // service-agnostic adapter stays reusable).
    private String component = "";

    // Populated only when the request failed with an exception the filter saw.
    private @Nullable WideEventError error;

    // Extensible free-form attributes; empty by default.
    private Map<String, String> attributes = new LinkedHashMap<>();

    /** avaje-jsonb requires an accessible no-arg constructor for the generated adapter. */
    public WideEvent() {}

    public String getTraceId() {
        return traceId;
    }

    public void setTraceId(String traceId) {
        this.traceId = traceId;
    }

    public String getSpanId() {
        return spanId;
    }

    public void setSpanId(String spanId) {
        this.spanId = spanId;
    }

    public @Nullable String getParentSpanId() {
        return parentSpanId;
    }

    public void setParentSpanId(@Nullable String parentSpanId) {
        this.parentSpanId = parentSpanId;
    }

    public String getTimestamp() {
        return timestamp;
    }

    public void setTimestamp(String timestamp) {
        this.timestamp = timestamp;
    }

    public long getDurationMs() {
        return durationMs;
    }

    public void setDurationMs(long durationMs) {
        this.durationMs = durationMs;
    }

    public String getHttpMethod() {
        return httpMethod;
    }

    public void setHttpMethod(String httpMethod) {
        this.httpMethod = httpMethod;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public int getStatus() {
        return status;
    }

    public void setStatus(int status) {
        this.status = status;
    }

    public @Nullable String getConnectCode() {
        return connectCode;
    }

    public void setConnectCode(@Nullable String connectCode) {
        this.connectCode = connectCode;
    }

    public @Nullable String getRpcMethod() {
        return rpcMethod;
    }

    public void setRpcMethod(@Nullable String rpcMethod) {
        this.rpcMethod = rpcMethod;
    }

    public String getComponent() {
        return component;
    }

    public void setComponent(String component) {
        this.component = component;
    }

    public @Nullable WideEventError getError() {
        return error;
    }

    public void setError(@Nullable WideEventError error) {
        this.error = error;
    }

    public Map<String, String> getAttributes() {
        return attributes;
    }

    public void setAttributes(Map<String, String> attributes) {
        this.attributes = attributes;
    }
}
