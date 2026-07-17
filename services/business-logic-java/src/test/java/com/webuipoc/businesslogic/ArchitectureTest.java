package com.webuipoc.businesslogic;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

/**
 * Machine-enforced architecture rules for the business-logic service — the executable equivalent of the AGENTS.md
 * "Working agreements" (keep the two services honest; the business core stays framework-free; JDBC lives in one place).
 *
 * <p>Scope choice (generated-code exclusion): {@code @AnalyzeClasses} is rooted at
 * {@code com.webuipoc.businesslogic}. The buf/protoc generated proto + gRPC stubs live under {@code todo.v1..} and
 * {@code build.buf.validate..}, so they are OUT of this root by construction and no rule can fire on them.
 * {@link ImportOption.DoNotIncludeTests} drops the {@code target/test-classes} compilation output so these production
 * layering rules never trip over test doubles (e.g. the StreamObserver-implementing StubTodoService). The remaining
 * in-package avaje-generated code (avaje-inject {@code $DI} / {@code BusinesslogicModule}, avaje-validation adapters)
 * is filtered out per-rule via {@link #GENERATED_CODE} — those emitters legitimately reference framework types (e.g.
 * {@code io.grpc.BindableService}) that a working agreement should not police in hand-written code. MapStruct
 * {@code *Impl} output is NOT covered by that predicate (see its Javadoc) and needs no exclusion: no rule fires on it.
 * Every rule fails the build on violation; there is no freeze/baseline.
 */
@AnalyzeClasses(packages = "com.webuipoc.businesslogic", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    /**
     * Avaje annotation-processor output carries a CLASS-retention {@code io.avaje.*.spi.Generated} marker (verified
     * via javap: avaje-inject {@code $DI}/{@code BusinesslogicModule} and avaje-validation adapters do). MapStruct's
     * {@code @Generated} is SOURCE-retention, so {@code TodoMapperImpl.class} carries NO annotation and this predicate
     * never matches MapStruct output — currently moot because no rule fires on it; if a future rule ever needs to
     * exclude MapStruct {@code *Impl} classes, add a name/package-based predicate leg instead. Known trust boundary:
     * any class annotated with a {@code *.Generated} annotation dodges these rules — acceptable here because such an
     * annotation on hand-written code is visible in diff review.
     */
    private static final DescribedPredicate<JavaClass> GENERATED_CODE =
            new DescribedPredicate<JavaClass>("generated code (annotated @Generated)") {
                @Override
                public boolean test(JavaClass javaClass) {
                    return javaClass.getAnnotations().stream()
                            .anyMatch(annotation ->
                                    annotation.getRawType().getName().endsWith(".Generated"));
                }
            };

    // AGENTS.md: the business core is plain Java. Domain records/commands carry no framework: no Helidon webserver
    // types, no gRPC, no generated proto (todo.v1) and no protobuf runtime/protovalidate types — a domain record
    // holding proto Timestamp/Struct instead of java.time is exactly the leak this prevents. Mapping to/from proto
    // is the mapper's job, not the domain's.
    @ArchTest
    static final ArchRule domain_records_stay_framework_free = noClasses()
            .that()
            .resideInAPackage("..businesslogic.domain..")
            .and(DescribedPredicate.not(GENERATED_CODE))
            .should()
            .dependOnClassesThat()
            .resideInAnyPackage(
                    "io.helidon..", "io.grpc..", "todo.v1..", "com.google.protobuf..", "build.buf.validate..")
            .because("domain records are the plain business core; Helidon, gRPC, generated proto and protobuf "
                    + "runtime types belong to the service's edges, not to the domain");

    // AGENTS.md: "Keep the two services honest." Helidon WebServer wiring is confined to the Main composition root;
    // the rest of the service (domain, todo core, mapper, config) must not reach for the HTTP framework.
    @ArchTest
    static final ArchRule helidon_is_confined_to_the_bootstrap = noClasses()
            .that()
            .doNotHaveFullyQualifiedName("com.webuipoc.businesslogic.Main")
            .and(DescribedPredicate.not(GENERATED_CODE))
            .should()
            .dependOnClassesThat()
            .resideInAPackage("io.helidon..")
            .because("only the Main composition root wires the Helidon WebServer; the business core stays "
                    + "framework-free");

    // AGENTS.md: "The business-logic server must be the only SQLite client." Within the server, raw JDBC / SQLite
    // access is confined to the persistence classes (TodoDb owns the connection + schema, TodoRepository owns the SQL).
    @ArchTest
    static final ArchRule jdbc_is_confined_to_the_persistence_classes = noClasses()
            .that()
            .doNotHaveFullyQualifiedName("com.webuipoc.businesslogic.todo.TodoDb")
            .and()
            .doNotHaveFullyQualifiedName("com.webuipoc.businesslogic.todo.TodoRepository")
            .and(DescribedPredicate.not(GENERATED_CODE))
            .should()
            .dependOnClassesThat()
            .resideInAnyPackage("java.sql..", "org.sqlite..")
            .because("JDBC/SQLite access lives only in TodoDb (connection + schema) and TodoRepository (SQL); "
                    + "the rest of the service talks to the domain, not the database");

    // AGENTS.md layering: StreamObserver is the gRPC unary edge. Only TodoGrpcBridge translates domain calls into the
    // generated StreamObserver-based service; the business core (TodoService, TodoRepository, ...) is plain methods.
    @ArchTest
    static final ArchRule streamobserver_is_confined_to_the_grpc_bridge = noClasses()
            .that()
            .doNotHaveFullyQualifiedName("com.webuipoc.businesslogic.todo.TodoGrpcBridge")
            .and(DescribedPredicate.not(GENERATED_CODE))
            .should()
            .dependOnClassesThat()
            .resideInAPackage("io.grpc.stub..")
            .because("StreamObserver is the gRPC edge adapted by TodoGrpcBridge; the business core exposes plain "
                    + "methods, never gRPC stub types");

    // Convention: test frameworks are a test-scope concern. No production class may depend on JUnit or ArchUnit.
    @ArchTest
    static final ArchRule test_frameworks_stay_in_test_scope = noClasses()
            .should()
            .dependOnClassesThat()
            .resideInAnyPackage("org.junit..", "com.tngtech.archunit..")
            .because("test frameworks belong to test scope; production classes must not depend on them");
}
