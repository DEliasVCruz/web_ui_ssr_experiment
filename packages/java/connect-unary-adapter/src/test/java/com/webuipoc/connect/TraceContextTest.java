package com.webuipoc.connect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** Unit tests for {@link TraceContext} resolution from an inbound {@code traceparent}. */
class TraceContextTest {

    private static final String TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
    private static final String PARENT_ID = "00f067aa0ba902b7";
    private static final String VALID = "00-" + TRACE_ID + "-" + PARENT_ID + "-01";

    @Test
    void adoptsInboundTraceAndGeneratesFreshSpan() {
        TraceContext ctx = TraceContext.resolve(VALID);
        assertEquals(TRACE_ID, ctx.traceId(), "inbound trace-id is adopted");
        assertEquals(PARENT_ID, ctx.parentSpanId(), "inbound parent-id becomes this span's parent");
        assertEquals(16, ctx.spanId().length(), "a fresh 16-hex span-id is generated");
        assertNotEquals(PARENT_ID, ctx.spanId(), "the generated span-id is not the caller's");
    }

    @Test
    void startsNewTraceWhenHeaderAbsent() {
        TraceContext ctx = TraceContext.resolve(null);
        assertEquals(32, ctx.traceId().length(), "a fresh 32-hex trace-id is generated");
        assertEquals(16, ctx.spanId().length(), "a fresh 16-hex span-id is generated");
        assertNull(ctx.parentSpanId(), "no parent when starting a new trace");
    }

    @Test
    void startsNewTraceWhenHeaderInvalid() {
        TraceContext ctx = TraceContext.resolve("garbage");
        assertEquals(32, ctx.traceId().length());
        assertNotEquals(TRACE_ID, ctx.traceId(), "an invalid header is not adopted");
        assertNull(ctx.parentSpanId());
    }

    @Test
    void generatesLowercaseHexIds() {
        TraceContext ctx = TraceContext.resolve(null);
        assertTrue(ctx.traceId().matches("[0-9a-f]{32}"));
        assertTrue(ctx.spanId().matches("[0-9a-f]{16}"));
    }
}
