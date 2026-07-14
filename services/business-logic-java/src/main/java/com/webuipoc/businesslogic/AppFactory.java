package com.webuipoc.businesslogic;

import com.webuipoc.businesslogic.mapper.TodoMapper;
import com.webuipoc.businesslogic.mapper.TodoMapperImpl;
import com.webuipoc.businesslogic.todo.TodoDb;
import io.avaje.inject.Bean;
import io.avaje.inject.Factory;
import io.avaje.validation.Validator;

/**
 * avaje-inject factory for the beans that are not plain {@code @Singleton}
 * classes: the SQLite {@link TodoDb}, the avaje {@link Validator}, and the
 * MapStruct {@link TodoMapper}.
 *
 * <p>{@link TodoDb} is {@code AutoCloseable}, so avaje closes the single SQLite
 * connection when the {@code BeanScope} closes (see {@code Main} — the scope's
 * JVM shutdown hook). The {@link Validator} auto-discovers the generated
 * validation adapters via {@code ServiceLoader} at {@code build()}. The mapper
 * is the MapStruct-generated {@code TodoMapperImpl} (default component model).
 */
@Factory
public class AppFactory {

    /** Single SQLite connection per process (env: DATABASE_PATH). Closed on scope close. */
    @Bean
    TodoDb todoDb() {
        return TodoDb.open();
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
