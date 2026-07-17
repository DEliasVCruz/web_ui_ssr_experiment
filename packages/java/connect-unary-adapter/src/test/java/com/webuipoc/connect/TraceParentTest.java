package com.webuipoc.connect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.Objects;
import org.junit.jupiter.api.Test;

/** Unit tests for the hand-rolled W3C {@code traceparent} parser. */
class TraceParentTest {

    private static final String VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    private static final String TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
    private static final String PARENT_ID = "00f067aa0ba902b7";

    @Test
    void parsesAValidTraceparent() {
        TraceParent parsed = Objects.requireNonNull(TraceParent.parse(VALID));
        assertEquals(TRACE_ID, parsed.traceId());
        assertEquals(PARENT_ID, parsed.parentId());
        assertEquals("01", parsed.flags());
    }

    @Test
    void acceptsFlagsOtherThanSampled() {
        // trace-flags is opaque to us (we do not sample); 00 (not-sampled) is valid.
        TraceParent parsed =
                Objects.requireNonNull(TraceParent.parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"));
        assertEquals("00", parsed.flags());
    }

    @Test
    void rejectsNull() {
        assertNull(TraceParent.parse(null));
    }

    @Test
    void rejectsWrongLength() {
        assertNull(TraceParent.parse("00-abc-def-01"));
        assertNull(TraceParent.parse(VALID + "0"));
    }

    @Test
    void rejectsBadDelimiters() {
        // Replace the first '-' with '_'.
        assertNull(TraceParent.parse("00_4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"));
    }

    @Test
    void rejectsUnsupportedVersion() {
        assertNull(TraceParent.parse("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"));
        // ff is the "invalid" version byte per the spec.
        assertNull(TraceParent.parse("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"));
    }

    @Test
    void rejectsUppercaseHex() {
        // W3C mandates lowercase hex; an uppercase id is invalid (the caller regenerates).
        assertNull(TraceParent.parse("00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01"));
    }

    @Test
    void rejectsNonHex() {
        assertNull(TraceParent.parse("00-4bf92f3577b34da6a3ce929d0e0e473g-00f067aa0ba902b7-01"));
    }

    @Test
    void rejectsAllZeroTraceId() {
        assertNull(TraceParent.parse("00-00000000000000000000000000000000-00f067aa0ba902b7-01"));
    }

    @Test
    void rejectsAllZeroParentId() {
        assertNull(TraceParent.parse("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"));
    }
}
