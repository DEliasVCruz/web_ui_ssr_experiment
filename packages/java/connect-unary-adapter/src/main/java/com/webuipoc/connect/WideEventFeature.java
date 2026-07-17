package com.webuipoc.connect;

import io.helidon.common.Weighted;
import io.helidon.webserver.http.HttpFeature;
import io.helidon.webserver.http.HttpRouting;
import java.io.PrintStream;

/**
 * Helidon routing feature that installs the {@link WideEventFilter} for
 * wide-event request logging.
 *
 * <p>Registered by the composition root ({@code Main}) alongside
 * {@link ConnectUnaryFeature}. The {@code component} name — the value of the
 * event's {@code component} field — is supplied by the caller rather than
 * hardcoded, so this adapter stays service-agnostic and reusable (the same reason
 * {@link ConnectUnaryFeature} takes the service, not a service name).
 *
 * <p>It declares a high {@link Weighted weight} so Helidon runs its {@code setup}
 * (and hence registers its filter) before the default-weight routing and
 * {@link ConnectCors} filters: the wide-event filter must be the outermost filter
 * so its completion path wraps the entire request and its {@code duration_ms}
 * covers all of it.
 */
public final class WideEventFeature implements HttpFeature, Weighted {

    /** Above {@link Weighted#DEFAULT_WEIGHT} (100) so this feature is set up first (outermost filter). */
    private static final double WEIGHT = 1000.0;

    private final WideEventFilter filter;

    private WideEventFeature(String component, PrintStream out) {
        this.filter = new WideEventFilter(component, out);
    }

    /** Creates the feature emitting wide events (tagged with {@code component}) to {@code System.out}. */
    public static WideEventFeature create(String component) {
        return new WideEventFeature(component, System.out);
    }

    /** Test seam: emit to a caller-provided stream instead of {@code System.out}. */
    static WideEventFeature create(String component, PrintStream out) {
        return new WideEventFeature(component, out);
    }

    @Override
    public void setup(HttpRouting.Builder routing) {
        routing.addFilter(filter);
    }

    @Override
    public double weight() {
        return WEIGHT;
    }
}
