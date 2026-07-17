package com.webuipoc.businesslogic.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.avaje.config.Configuration;
import org.junit.jupiter.api.Test;

/**
 * Tests for the avaje-config wiring and the {@link ServiceConfig} typed holder.
 *
 * <p>Each test builds an ISOLATED avaje-config {@link Configuration} via
 * {@code Configuration.builder()} (which does not touch the global {@code Config}
 * singleton), so the cases are independent and deterministic. {@code build()}
 * evaluates {@code ${VAR:default}} expressions, and expression resolution checks
 * system properties then environment variables — the same precedence the running
 * service uses — so the override tests below exercise the real mechanism.
 */
class ServiceConfigTest {

    /**
     * The packaged {@code application.yaml} supplies the defaults: port 3001 and
     * the local {@code ./data/todos.db} path (no overrides present).
     */
    @Test
    void applicationYamlProvidesDefaults() {
        Configuration config = Configuration.builder().load("application.yaml").build();

        ServiceConfig serviceConfig = ServiceConfig.from(config);
        assertEquals(3001, serviceConfig.serverPort());
        assertEquals("./data/todos.db", serviceConfig.databasePath());
    }

    /**
     * Layering the {@code docker} profile file on top of the base overrides the
     * database path to the container volume location — this is the profile
     * mechanism the Dockerfile activates via {@code CONFIG_PROFILES=docker}.
     */
    @Test
    void dockerProfileOverridesDatabasePath() {
        Configuration config = Configuration.builder()
                .load("application.yaml")
                .load("application-docker.yaml")
                .build();

        ServiceConfig serviceConfig = ServiceConfig.from(config);
        assertEquals("/data/todos.db", serviceConfig.databasePath());
        // The port is not touched by the docker profile — still the base default.
        assertEquals(3001, serviceConfig.serverPort());
    }

    /**
     * The historical env-var names (PORT / DATABASE_PATH) still override the
     * file defaults. avaje-config expression resolution consults system
     * properties ahead of env vars, so a system property with the same name
     * exercises the identical code path an environment variable would — and lets
     * the test set/clear it deterministically.
     */
    @Test
    void portAndDatabasePathOverridesWin() {
        System.setProperty("PORT", "9999");
        System.setProperty("DATABASE_PATH", "/tmp/override-todos.db");
        try {
            Configuration config =
                    Configuration.builder().load("application.yaml").build();

            ServiceConfig serviceConfig = ServiceConfig.from(config);
            assertEquals(9999, serviceConfig.serverPort());
            assertEquals("/tmp/override-todos.db", serviceConfig.databasePath());
        } finally {
            System.clearProperty("PORT");
            System.clearProperty("DATABASE_PATH");
        }
    }

    /**
     * The DATABASE_PATH override still wins even with the docker profile active:
     * an operator (or the e2e harness, which sets DATABASE_PATH to an ephemeral
     * file) can always repoint the database. Guards the precedence
     * env/system-property &gt; profile file.
     */
    @Test
    void databasePathOverrideBeatsDockerProfile() {
        System.setProperty("DATABASE_PATH", "/tmp/ephemeral-e2e.db");
        try {
            Configuration config = Configuration.builder()
                    .load("application.yaml")
                    .load("application-docker.yaml")
                    .build();

            assertEquals("/tmp/ephemeral-e2e.db", ServiceConfig.from(config).databasePath());
        } finally {
            System.clearProperty("DATABASE_PATH");
        }
    }

    /**
     * The typed holder maps the two known keys straight off the Configuration.
     */
    @Test
    void typedHolderReadsConfiguredKeys() {
        Configuration config = Configuration.builder()
                .put(ServiceConfig.KEY_SERVER_PORT, "7777")
                .put(ServiceConfig.KEY_DB_PATH, "/var/lib/todos.db")
                .build();

        ServiceConfig serviceConfig = ServiceConfig.from(config);
        assertEquals(7777, serviceConfig.serverPort());
        assertEquals("/var/lib/todos.db", serviceConfig.databasePath());
    }

    /**
     * With no file and no keys present the holder falls back to the code-level
     * defaults, which match the application.yaml defaults.
     */
    @Test
    void typedHolderFallsBackToCodeDefaults() {
        ServiceConfig serviceConfig = ServiceConfig.from(Configuration.builder().build());
        assertEquals(3001, serviceConfig.serverPort());
        assertEquals("./data/todos.db", serviceConfig.databasePath());
    }

    /**
     * A non-numeric port FAILS FAST instead of silently falling back to 3001
     * (the retired Bun service's leniency was deliberately dropped — config
     * errors should be loud). Pins the deliberate semantics change: with
     * PORT=abc the ${PORT:3001} expression resolves to "abc" and startup dies
     * with NumberFormatException. Exercised both through the direct key and
     * through the real application.yaml expression path.
     */
    @Test
    void invalidPortFailsFast() {
        Configuration direct = Configuration.builder()
                .put(ServiceConfig.KEY_SERVER_PORT, "abc")
                .build();
        assertThrows(NumberFormatException.class, () -> ServiceConfig.from(direct));

        // Same failure through the packaged application.yaml's ${PORT:3001}
        // expression, i.e. the exact path a bad PORT env var takes at startup.
        System.setProperty("PORT", "not-a-number");
        try {
            Configuration viaYaml =
                    Configuration.builder().load("application.yaml").build();
            assertThrows(NumberFormatException.class, () -> ServiceConfig.from(viaYaml));
        } finally {
            System.clearProperty("PORT");
        }
    }
}
