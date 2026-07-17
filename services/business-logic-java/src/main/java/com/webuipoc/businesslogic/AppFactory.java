package com.webuipoc.businesslogic;

import com.webuipoc.businesslogic.config.ServiceConfig;
import com.webuipoc.businesslogic.mapper.TodoMapper;
import com.webuipoc.businesslogic.mapper.TodoMapperImpl;
import com.webuipoc.businesslogic.todo.TodoDb;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import io.avaje.config.Config;
import io.avaje.inject.Bean;
import io.avaje.inject.Factory;
import io.avaje.validation.Validator;
import javax.sql.DataSource;

/**
 * avaje-inject factory for the beans that are not plain {@code @Singleton}
 * classes: the typed {@link ServiceConfig}, the HikariCP {@link DataSource}, the
 * {@link TodoDb} (which runs Flyway on construction), the avaje {@link Validator},
 * and the MapStruct {@link TodoMapper}.
 *
 * <p>{@link ServiceConfig} is read once from avaje-config's global
 * {@code Config.asConfiguration()} (application.yaml + profiles + env/system-property
 * overrides) and injected wherever service configuration is needed — the
 * datasource bean takes its URL/credentials/pool sizing from it here, and
 * {@code Main} bridges the server port into the Helidon {@code WebServer.builder()}.
 *
 * <p>The {@link HikariDataSource} is {@code AutoCloseable}, so avaje closes the
 * connection pool when the {@code BeanScope} closes (see {@code Main} — the
 * scope's JVM shutdown hook). The {@link Validator} auto-discovers the generated
 * validation adapters via {@code ServiceLoader} at {@code build()}. The mapper is
 * the MapStruct-generated {@code TodoMapperImpl} (default component model).
 */
@Factory
public class AppFactory {

    /** Typed configuration holder from avaje-config (application.yaml + overrides). */
    @Bean
    ServiceConfig serviceConfig() {
        return ServiceConfig.from(Config.asConfiguration());
    }

    /**
     * The HikariCP connection pool. Closed on scope close (implements
     * {@code AutoCloseable}).
     *
     * <p>Pool sizing is deliberately lean (default 16 max / 4 idle) — sized for
     * the database's connection budget, NOT for the virtual-thread request count.
     *
     * <p>pgjdbc tuning (documented choices; set as datasource properties rather
     * than baked into the URL so an operator-supplied bare {@code DATABASE_URL}
     * cannot silently drop them):
     * <ul>
     *   <li>{@code prepareThreshold=1} — use server-side prepared statements from
     *       the very first execution (default is 5). Binary transfer is already
     *       default-on in pgjdbc.</li>
     *   <li>{@code preparedStatementCacheQueries=256} /
     *       {@code preparedStatementCacheSizeMiB=5} — the pgjdbc defaults, pinned
     *       explicitly so the per-connection statement cache is a deliberate,
     *       visible choice.</li>
     * </ul>
     */
    @Bean
    HikariDataSource dataSource(ServiceConfig config) {
        HikariConfig hikari = new HikariConfig();
        hikari.setPoolName("todo-pool");
        hikari.setJdbcUrl(config.dbUrl());
        hikari.setUsername(config.dbUsername());
        hikari.setPassword(config.dbPassword());
        hikari.setMaximumPoolSize(config.dbPoolMaxSize());
        hikari.setMinimumIdle(config.dbPoolMinIdle());
        hikari.addDataSourceProperty("prepareThreshold", "1");
        hikari.addDataSourceProperty("preparedStatementCacheQueries", "256");
        hikari.addDataSourceProperty("preparedStatementCacheSizeMiB", "5");
        return new HikariDataSource(hikari);
    }

    /** Runs Flyway migrations on construction, then hands connections to the repository. */
    @Bean
    TodoDb todoDb(DataSource dataSource) {
        return new TodoDb(dataSource);
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
