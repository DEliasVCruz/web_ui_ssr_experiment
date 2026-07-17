package com.webuipoc.connect;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

/**
 * Machine-enforced architecture rule for the Connect-unary adapter.
 *
 * <p>The adapter's whole reason to exist (see its pom description) is to expose <em>any</em> gRPC
 * {@code ServerServiceDefinition} over the Connect protocol. That contract only holds if it never learns about a
 * concrete service. This test roots {@code @AnalyzeClasses} at {@code com.webuipoc.connect} (the adapter's own code;
 * generated proto/gRPC is not even on this module's classpath) and {@link ImportOption.DoNotIncludeTests} keeps the
 * adapter's own unit tests out of scope. The rule fails the build on violation — no freeze/baseline.
 */
@AnalyzeClasses(packages = "com.webuipoc.connect", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    /**
     * avaje-jsonb's generator emits adapters ({@code WideEventJsonAdapter}, {@code WideEventErrorJsonAdapter}) and a
     * {@code jsonb.GeneratedJsonComponent}, all carrying a CLASS-retention {@code io.avaje.jsonb.spi.Generated} marker
     * (verified via javap). Those generated classes legitimately reference {@code io.avaje.jsonb}; this predicate
     * filters them out of the confinement rule below so it polices only hand-written code. Same trust boundary as the
     * service module's equivalent predicate: a {@code *.Generated} annotation on hand-written code is visible in review.
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

    // AGENTS.md service split: the adapter is service-agnostic. It must never depend on a concrete service's business
    // logic — that would couple the reusable Connect machinery to one service and break its "dispatch any service" job.
    @ArchTest
    static final ArchRule adapter_stays_service_agnostic = noClasses()
            .should()
            .dependOnClassesThat()
            .resideInAPackage("com.webuipoc.businesslogic..")
            .because("the Connect-unary adapter dispatches any gRPC ServerServiceDefinition and must stay "
                    + "service-agnostic — no dependency on a concrete service's business logic");

    // Task iq2.1: avaje-jsonb is the codec for the wide-event LOG LINE only. The Connect wire codec (request/response
    // messages) stays on protobuf-java-util JsonFormat and the error envelope on hand-rolled JSON (ConnectErrorJson).
    // So only the hand-written wide-event types (WideEvent, WideEventError — @Json models — and WideEventFilter, which
    // drives the Jsonb instance) may depend on io.avaje.jsonb; generated adapters are excluded via GENERATED_CODE.
    // This keeps a second JSON library from silently spreading into the protocol machinery.
    @ArchTest
    static final ArchRule jsonb_is_confined_to_wide_event_logging = noClasses()
            .that()
            .haveSimpleNameNotStartingWith("WideEvent")
            .and(DescribedPredicate.not(GENERATED_CODE))
            .should()
            .dependOnClassesThat()
            .resideInAPackage("io.avaje.jsonb..")
            .because("avaje-jsonb serializes the wide-event log line only; the Connect wire codec stays on JsonFormat "
                    + "and the error envelope on hand-rolled JSON — the JSON library must not spread further");
}
