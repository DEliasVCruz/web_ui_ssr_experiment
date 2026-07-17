package com.webuipoc.businesslogic;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.util.Properties;
import java.util.logging.Formatter;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Teeth for the framework-log JSON wiring (task iq2.2). Pins that the fields config SHIPPED in
 * {@code logging.properties} renders each JUL record as a single-line JSON object whose keys align
 * with the wide-event naming convention (docs/logging.md).
 *
 * <p>The formatter reads its field spec from the global {@link java.util.logging.LogManager} in its
 * public constructor; to keep this test hermetic (no global logging mutation) it reads the exact
 * {@code fields} value out of the real {@code logging.properties} resource and feeds it to the
 * package-private {@code HelidonJsonFormatter(String, boolean)} constructor via reflection. This
 * deliberately exercises the ACTUAL shipped spec, so a future edit to {@code logging.properties}
 * that breaks the JSON shape fails here.
 */
class FrameworkLoggingFormatTest {

    private static final String FORMATTER_CLASS = "io.helidon.logging.jul.HelidonJsonFormatter";
    private static final String FIELDS_KEY = "io.helidon.logging.jul.HelidonJsonFormatter.fields";

    /**
     * ISO-like date-time with a basic (colon-less) {@code ±hhmm} offset, e.g.
     * {@code 2026-07-17T08:11:24.963-0500} — deliberately NOT strict RFC-3339 (see docs/logging.md).
     */
    private static final Pattern ISO_WITH_OFFSET =
            Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}[+-]\\d{4}$");

    private static String shippedFieldsSpec() throws Exception {
        Properties props = new Properties();
        try (InputStream in = FrameworkLoggingFormatTest.class.getResourceAsStream("/logging.properties")) {
            assertNotNull(in, "logging.properties must be on the classpath");
            props.load(in);
        }
        String fields = props.getProperty(FIELDS_KEY);
        assertNotNull(fields, FIELDS_KEY + " must be set in logging.properties");
        return fields;
    }

    // Reflectively reaches HelidonJsonFormatter's package-private (String, boolean) constructor so the
    // test can drive the EXACT shipped fields spec without mutating the global LogManager (the public
    // constructor reads the spec from LogManager). Legitimate test-only reflection into a library type;
    // the PMD accessibility-alteration ban targets production code.
    @SuppressWarnings("PMD.AvoidAccessibilityAlteration")
    private static Formatter formatterFor(String fieldsSpec) throws Exception {
        Class<?> cls = Class.forName(FORMATTER_CLASS);
        Constructor<?> ctor = cls.getDeclaredConstructor(String.class, boolean.class);
        ctor.setAccessible(true);
        return (Formatter) ctor.newInstance(fieldsSpec, true);
    }

    private static JsonObject renderAsJson(LogRecord record) throws Exception {
        String line = formatterFor(shippedFieldsSpec()).format(record);
        // One record renders as exactly one line (one trailing newline) holding one JSON object.
        assertEquals(1, line.chars().filter(ch -> ch == '\n').count(), "exactly one trailing newline");
        String json = line.strip();
        assertTrue(json.startsWith("{") && json.endsWith("}"), "a JSON object: " + json);
        return JsonParser.parseString(json).getAsJsonObject();
    }

    @Test
    void shippedConfigRendersAlignedJsonForAPlainRecord() throws Exception {
        LogRecord record = new LogRecord(Level.INFO, "business-logic-java listening on http://localhost:3001");
        record.setLoggerName("com.webuipoc.businesslogic.Main");

        JsonObject json = renderAsJson(record);

        assertEquals("INFO", json.get("level").getAsString());
        assertEquals(
                "business-logic-java listening on http://localhost:3001",
                json.get("message").getAsString());
        assertEquals("com.webuipoc.businesslogic.Main", json.get("logger").getAsString());

        // timestamp key present with an ISO-like basic-offset value (NOT a hard-coded 'Z' — the
        // formatter renders the JVM's real zone offset; not strict RFC-3339, see docs/logging.md).
        assertTrue(json.has("timestamp"), "timestamp key present: " + json);
        String ts = json.get("timestamp").getAsString();
        assertTrue(ISO_WITH_OFFSET.matcher(ts).matches(), "timestamp is ISO-like with basic ±hhmm offset: " + ts);

        // Blank fields are omitted: no throwable -> no exception key; unnamed vthreads -> no thread key.
        assertFalse(json.has("exception"), "no exception key without a throwable: " + json);
        assertFalse(json.has("thread"), "thread field is intentionally dropped: " + json);
    }

    @Test
    void shippedConfigIncludesTheStackTraceWhenARecordCarriesAThrowable() throws Exception {
        LogRecord record = new LogRecord(Level.SEVERE, "boot failed");
        record.setLoggerName("com.zaxxer.hikari.pool.HikariPool");
        record.setThrown(new IllegalStateException("no database reachable"));

        JsonObject json = renderAsJson(record);

        assertEquals("SEVERE", json.get("level").getAsString());
        assertTrue(json.has("exception"), "exception key present for a throwable: " + json);
        String exception = json.get("exception").getAsString();
        assertTrue(exception.contains("IllegalStateException"), "stack trace carries the type: " + exception);
        assertTrue(exception.contains("no database reachable"), "stack trace carries the message: " + exception);
    }

    @Test
    void abogusFieldsSpecFailsLoudAtFormatterConstruction() {
        // A field with no colon has no jsonName:value split. The formatter rejects it in its
        // constructor with IllegalArgumentException (documented behavior). In the real runtime this
        // surfaces at handler configuration, where JUL falls back to the default plain formatter
        // rather than crashing the process — see docs/logging.md / the task teeth notes.
        InvocationTargetException wrapped =
                assertThrows(InvocationTargetException.class, () -> formatterFor("garbage_without_a_colon"));
        assertInstanceOf(IllegalArgumentException.class, wrapped.getCause(), "cause is IllegalArgumentException");
    }
}
