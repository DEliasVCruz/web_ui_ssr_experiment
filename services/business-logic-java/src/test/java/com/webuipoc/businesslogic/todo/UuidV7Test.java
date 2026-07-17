package com.webuipoc.businesslogic.todo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class UuidV7Test {

    /** Canonical lowercase UUID with version 7 and RFC 9562 variant (10xx → 8/9/a/b). */
    private static final Pattern UUID_V7 =
            Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

    @Test
    void hasVersion7AndRfc9562VariantBits() {
        for (int i = 0; i < 100; i++) {
            String id = UuidV7.randomUuidV7();
            assertTrue(UUID_V7.matcher(id).matches(), "not a canonical UUIDv7: " + id);
        }
    }

    @Test
    void timestampSegmentEncodesCurrentUnixMillis() throws InterruptedException {
        // Let the wall clock get ahead of any milliseconds "borrowed" by the
        // monotonic counter in other tests (the generator state is static).
        Thread.sleep(20);
        long before = System.currentTimeMillis();
        String id = UuidV7.randomUuidV7();
        long after = System.currentTimeMillis();

        long encodedMs = Long.parseLong(id.substring(0, 8) + id.substring(9, 13), 16);
        // The monotonic counter may borrow at most a few ms ahead under contention.
        assertTrue(
                encodedMs >= before && encodedMs <= after + 10,
                "timestamp segment " + encodedMs + " outside [" + before + ", " + after + "]");
    }

    @Test
    void idsAreTemporallyMonotonic() {
        String previous = UuidV7.randomUuidV7();
        for (int i = 0; i < 10_000; i++) {
            String next = UuidV7.randomUuidV7();
            // Strictly increasing as strings (timestamp segment + rand_a counter),
            // like Bun's randomUUIDv7 — this is what keeps time-ordering stable.
            assertTrue(next.compareTo(previous) > 0, "expected " + next + " > " + previous);
            previous = next;
        }
    }

    @Test
    void uuidsAreUnique() {
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (int i = 0; i < 10_000; i++) {
            assertTrue(seen.add(UuidV7.randomUuidV7()));
        }
        assertEquals(10_000, seen.size());
    }
}
