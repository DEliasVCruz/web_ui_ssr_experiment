package com.webuipoc.connect;

import java.security.SecureRandom;
import java.util.HexFormat;
import org.jspecify.annotations.Nullable;

/**
 * The trace context adopted for one request: the {@code trace_id} it belongs to,
 * the fresh {@code span_id} generated for this server's handling of it, and the
 * {@code parent_span_id} (the caller's span) when a valid inbound
 * {@code traceparent} supplied one.
 *
 * <p>Resolution follows W3C Trace Context: a valid inbound {@code traceparent}
 * has its trace-id <em>adopted</em> and its parent-id recorded as this span's
 * parent, while a new span-id is always minted for this hop; an absent or invalid
 * header starts a brand-new trace (fresh trace-id + span-id, no parent). Ids are
 * generated from {@link SecureRandom} and lowercase-hex encoded (16 hex for a
 * span, 32 for a trace), matching the W3C id widths.
 *
 * @param traceId the 32-hex trace id
 * @param spanId this hop's freshly generated 16-hex span id
 * @param parentSpanId the caller's 16-hex span id, or {@code null} if this
 *     request starts the trace
 */
record TraceContext(String traceId, String spanId, @Nullable String parentSpanId) {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final HexFormat HEX = HexFormat.of();
    private static final int TRACE_ID_BYTES = 16;
    private static final int SPAN_ID_BYTES = 8;

    /**
     * Resolves the trace context from an inbound {@code traceparent} header value
     * (may be {@code null}). A valid header adopts its trace-id and records its
     * parent-id; otherwise a new trace is started.
     */
    static TraceContext resolve(@Nullable String traceparent) {
        TraceParent parsed = TraceParent.parse(traceparent);
        if (parsed == null) {
            return new TraceContext(newId(TRACE_ID_BYTES), newId(SPAN_ID_BYTES), null);
        }
        return new TraceContext(parsed.traceId(), newId(SPAN_ID_BYTES), parsed.parentId());
    }

    private static String newId(int byteCount) {
        byte[] bytes = new byte[byteCount];
        RANDOM.nextBytes(bytes);
        return HEX.formatHex(bytes);
    }
}
