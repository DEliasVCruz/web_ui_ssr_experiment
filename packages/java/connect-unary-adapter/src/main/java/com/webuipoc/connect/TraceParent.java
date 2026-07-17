package com.webuipoc.connect;

import org.jspecify.annotations.Nullable;

/**
 * A parsed W3C Trace Context {@code traceparent} header
 * (https://www.w3.org/TR/trace-context/#traceparent-header).
 *
 * <p>Deliberately a hand-rolled, fixed-width parser rather than an OpenTelemetry
 * dependency: this service is agent-free by design (see {@code docs/wide-events.md}).
 * The version-{@code 00} format is fixed 55 ASCII characters:
 *
 * <pre>{@code
 *   00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *   ^^ ^------------------------------^ ^--------------^ ^^
 *   |  trace-id (32 lowercase hex)      parent-id (16)   flags (2)
 *   version (2)
 * }</pre>
 *
 * <p>Strictness (all rejections cause the caller to generate a fresh trace):
 * only version {@code 00}; only lowercase hex digits (the spec mandates
 * lowercase — an uppercase id is treated as invalid); an all-zero trace-id or
 * all-zero parent-id is rejected (the spec forbids them).
 *
 * @param traceId the 32-hex trace id
 * @param parentId the 16-hex parent (caller) span id
 * @param flags the 2-hex trace-flags
 */
record TraceParent(String traceId, String parentId, String flags) {

    private static final int TRACEPARENT_LENGTH = 55;
    private static final int TRACE_ID_START = 3;
    private static final int TRACE_ID_END = 35;
    private static final int PARENT_ID_START = 36;
    private static final int PARENT_ID_END = 52;
    private static final int FLAGS_START = 53;
    private static final String SUPPORTED_VERSION = "00";
    private static final char HEX_ZERO = '0';

    /**
     * Parses a {@code traceparent} header value, returning {@code null} for any
     * absent/malformed/forbidden value (the caller then starts a new trace).
     */
    static @Nullable TraceParent parse(@Nullable String value) {
        if (value == null || value.length() != TRACEPARENT_LENGTH) {
            return null;
        }
        if (value.charAt(2) != '-' || value.charAt(TRACE_ID_END) != '-' || value.charAt(PARENT_ID_END) != '-') {
            return null;
        }
        if (!SUPPORTED_VERSION.equals(value.substring(0, 2))) {
            return null;
        }
        String traceId = value.substring(TRACE_ID_START, TRACE_ID_END);
        String parentId = value.substring(PARENT_ID_START, PARENT_ID_END);
        String flags = value.substring(FLAGS_START, TRACEPARENT_LENGTH);
        if (!isLowerHex(traceId) || !isLowerHex(parentId) || !isLowerHex(flags)) {
            return null;
        }
        if (isAllZero(traceId) || isAllZero(parentId)) {
            return null;
        }
        return new TraceParent(traceId, parentId, flags);
    }

    private static boolean isLowerHex(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!hex) {
                return false;
            }
        }
        return true;
    }

    private static boolean isAllZero(String value) {
        for (int i = 0; i < value.length(); i++) {
            if (value.charAt(i) != HEX_ZERO) {
                return false;
            }
        }
        return true;
    }
}
