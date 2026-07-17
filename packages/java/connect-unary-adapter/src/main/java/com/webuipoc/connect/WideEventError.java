package com.webuipoc.connect;

import io.avaje.jsonb.Json;
import java.io.PrintWriter;
import java.io.StringWriter;
import org.jspecify.annotations.Nullable;

/**
 * The {@code error} object of a {@link WideEvent}: an exception projected into
 * the wide-event schema ({@code type}, {@code message}, optional {@code stack}).
 *
 * <p>avaje-jsonb has no {@link Throwable} adapter (and none should exist —
 * serializing arbitrary throwables reflectively is exactly what the
 * reflection-free codec avoids), so a throwable is projected manually here into
 * a small {@code @Json} type the generator <em>can</em> emit an adapter for.
 * Only populated when a request actually fails with an exception the filter
 * sees; ordinary Connect errors (e.g. {@code not_found}) are carried by the
 * event's {@code connect_code} + HTTP {@code status}, not by this object.
 */
@Json
public final class WideEventError {

    private String type = "";
    private String message = "";
    private @Nullable String stack;

    /** avaje-jsonb requires an accessible no-arg constructor for the generated adapter. */
    public WideEventError() {}

    /**
     * Projects a throwable into the wide-event error schema: {@code type} is the
     * exception's fully-qualified class name, {@code message} its message (or the
     * simple class name when it has none), and {@code stack} the full printed
     * stack trace.
     */
    public static WideEventError from(Throwable throwable) {
        WideEventError error = new WideEventError();
        error.type = throwable.getClass().getName();
        String detail = throwable.getMessage();
        error.message = detail == null ? throwable.getClass().getSimpleName() : detail;
        StringWriter writer = new StringWriter();
        throwable.printStackTrace(new PrintWriter(writer));
        error.stack = writer.toString();
        return error;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }

    public @Nullable String getStack() {
        return stack;
    }

    public void setStack(@Nullable String stack) {
        this.stack = stack;
    }
}
