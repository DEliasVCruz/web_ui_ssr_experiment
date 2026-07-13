package com.webuipoc.businesslogic.todo;

import java.security.SecureRandom;

/**
 * RFC 9562 UUIDv7 generator, mirroring Bun's {@code randomUUIDv7()} used by the
 * Bun service ({@code services/business-logic/src/todo-repository.ts}).
 *
 * <p>Layout (RFC 9562 section 5.7):
 * <pre>
 *   unix_ts_ms (48 bits) | ver=7 (4 bits) | rand_a (12 bits)
 *   var=10 (2 bits) | rand_b (62 bits)
 * </pre>
 *
 * <p>Like Bun, {@code rand_a} is used as a monotonic counter (RFC 9562 section
 * 6.2, method 1): it is randomly seeded whenever the millisecond timestamp
 * advances and incremented for IDs generated within the same millisecond, so
 * generated IDs are strictly increasing as strings — which keeps the Bun
 * repository's {@code ORDER BY created_at DESC} time-ordering stable.
 */
public final class UuidV7 {

    private static final SecureRandom RANDOM = new SecureRandom();

    /** Counter seed keeps the top bit clear: 2^11 guaranteed increments per ms. */
    private static final int COUNTER_SEED_MASK = 0x7FF;
    private static final int COUNTER_MAX = 0xFFF;

    private static long lastTimestampMs = Long.MIN_VALUE;
    private static int counter;

    private UuidV7() {
    }

    /** Returns a new canonical lowercase UUIDv7 string, e.g. {@code 0190163d-8694-7afd-8912-...}. */
    public static synchronized String randomUuidV7() {
        long now = System.currentTimeMillis();
        if (now > lastTimestampMs) {
            lastTimestampMs = now;
            counter = RANDOM.nextInt() & COUNTER_SEED_MASK;
        } else {
            counter++;
            if (counter > COUNTER_MAX) {
                // Counter exhausted within this millisecond: borrow the next one.
                lastTimestampMs++;
                counter = RANDOM.nextInt() & COUNTER_SEED_MASK;
            }
        }
        return format(lastTimestampMs, counter, RANDOM.nextLong());
    }

    private static String format(long timestampMs, int randA, long randB) {
        // unix_ts_ms(48) | version 7(4) | rand_a(12)
        long high = (timestampMs << 16) | 0x7000L | (randA & 0xFFFL);
        // variant 10(2) | rand_b(62)
        long low = (randB & 0x3FFFFFFFFFFFFFFFL) | 0x8000000000000000L;
        return new java.util.UUID(high, low).toString();
    }
}
