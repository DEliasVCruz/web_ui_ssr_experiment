package com.webuipoc.businesslogic;

import com.webuipoc.businesslogic.config.ServiceConfig;
import com.webuipoc.businesslogic.mapper.TodoMapper;
import com.webuipoc.businesslogic.mapper.TodoMapperImpl;
import com.webuipoc.businesslogic.todo.TodoDb;
import io.avaje.config.Config;
import io.avaje.inject.Bean;
import io.avaje.inject.Factory;
import io.avaje.validation.Validator;

/**
 * avaje-inject factory for the beans that are not plain {@code @Singleton}
 * classes: the typed {@link ServiceConfig}, the SQLite {@link TodoDb}, the avaje
 * {@link Validator}, and the MapStruct {@link TodoMapper}.
 *
 * <p>{@link ServiceConfig} is read once from avaje-config's global
 * {@code Config.asConfiguration()} (application.yaml + profiles + env/system-property
 * overrides) and injected wherever service configuration is needed —
 * {@link TodoDb} takes its database path from it here, and {@code Main} bridges
 * the server port into the Helidon {@code WebServer.builder()}.
 *
 * <p>{@link TodoDb} is {@code AutoCloseable}, so avaje closes the single SQLite
 * connection when the {@code BeanScope} closes (see {@code Main} — the scope's
 * JVM shutdown hook). The {@link Validator} auto-discovers the generated
 * validation adapters via {@code ServiceLoader} at {@code build()}. The mapper
 * is the MapStruct-generated {@code TodoMapperImpl} (default component model).
 */
@Factory
public class AppFactory {

    /** Typed configuration holder from avaje-config (application.yaml + overrides). */
    @Bean
    ServiceConfig serviceConfig() {
        return ServiceConfig.from(Config.asConfiguration());
    }

    /** Single SQLite connection per process, at the configured db.path. Closed on scope close. */
    @Bean
    TodoDb todoDb(ServiceConfig config) {
        return new TodoDb(config.databasePath());
    }

    @Bean
    Validator validator() {
        return Validator.builder().build();
    }

    @Bean
    TodoMapper todoMapper() {
        return new TodoMapperImpl();
    }
}
