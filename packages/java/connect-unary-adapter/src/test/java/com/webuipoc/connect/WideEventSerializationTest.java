package com.webuipoc.connect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.avaje.jsonb.JsonType;
import io.avaje.jsonb.Jsonb;
import org.junit.jupiter.api.Test;

/**
 * Asserts the wide-event JSON shape (the schema in {@code docs/wide-events.md})
 * produced by the avaje-jsonb generated adapter, including snake_case keys,
 * always-present nullable keys, and manual error projection.
 */
class WideEventSerializationTest {

    // Mirrors WideEventFilter's own configuration so the assertions reflect production output.
    private final JsonType<WideEvent> type =
            Jsonb.builder().serializeNulls(true).build().type(WideEvent.class);

    private WideEvent sampleEvent() {
        WideEvent event = new WideEvent();
        event.setTraceId("4bf92f3577b34da6a3ce929d0e0e4736");
        event.setSpanId("00f067aa0ba902b7");
        event.setParentSpanId("aaaaaaaaaaaaaaaa");
        event.setTimestamp("2026-07-17T00:00:00Z");
        event.setDurationMs(42);
        event.setHttpMethod("POST");
        event.setPath("/todo.v1.TodoService/GetTodo");
        event.setStatus(200);
        event.setRpcMethod("todo.v1.TodoService/GetTodo");
        event.setComponent("business-logic-java");
        return event;
    }

    @Test
    void serializesSnakeCaseKeysAndValues() {
        String json = type.toJson(sampleEvent());
        assertTrue(json.contains("\"trace_id\":\"4bf92f3577b34da6a3ce929d0e0e4736\""), json);
        assertTrue(json.contains("\"span_id\":\"00f067aa0ba902b7\""), json);
        assertTrue(json.contains("\"parent_span_id\":\"aaaaaaaaaaaaaaaa\""), json);
        assertTrue(json.contains("\"duration_ms\":42"), json);
        assertTrue(json.contains("\"http_method\":\"POST\""), json);
        assertTrue(json.contains("\"path\":\"/todo.v1.TodoService/GetTodo\""), json);
        assertTrue(json.contains("\"status\":200"), json);
        assertTrue(json.contains("\"rpc_method\":\"todo.v1.TodoService/GetTodo\""), json);
        assertTrue(json.contains("\"component\":\"business-logic-java\""), json);
    }

    @Test
    void emitsSingleLine() {
        String json = type.toJson(sampleEvent());
        assertEquals(-1, json.indexOf('\n'), "the event must serialize to a single line");
    }

    @Test
    void keepsNullableSchemaKeysPresentWhenNull() {
        WideEvent event = sampleEvent();
        event.setParentSpanId(null);
        String json = type.toJson(event);
        // serializeNulls(true) keeps the schema stable: absent optional fields are explicit nulls, not dropped keys.
        assertTrue(json.contains("\"parent_span_id\":null"), json);
        assertTrue(json.contains("\"connect_code\":null"), json);
        assertTrue(json.contains("\"error\":null"), json);
    }

    @Test
    void roundTripsThroughTheAdapter() {
        WideEvent parsed = type.fromJson(type.toJson(sampleEvent()));
        assertEquals("4bf92f3577b34da6a3ce929d0e0e4736", parsed.getTraceId());
        assertEquals(200, parsed.getStatus());
        assertEquals("business-logic-java", parsed.getComponent());
    }

    @Test
    void projectsThrowableIntoErrorObject() {
        WideEvent event = sampleEvent();
        event.setStatus(500);
        event.setConnectCode("internal");
        event.setError(WideEventError.from(new IllegalStateException("boom")));
        String json = type.toJson(event);
        assertTrue(json.contains("\"connect_code\":\"internal\""), json);
        assertTrue(json.contains("\"type\":\"java.lang.IllegalStateException\""), json);
        assertTrue(json.contains("\"message\":\"boom\""), json);
        assertTrue(json.contains("\"stack\":\""), json);

        WideEvent parsed = type.fromJson(json);
        WideEventError error = parsed.getError();
        assertNotNull(error);
        assertEquals("java.lang.IllegalStateException", error.getType());
        assertEquals("boom", error.getMessage());
    }

    @Test
    void usesThrowableClassNameWhenMessageAbsent() {
        WideEventError error = WideEventError.from(new IllegalStateException());
        assertEquals("IllegalStateException", error.getMessage());
    }
}
