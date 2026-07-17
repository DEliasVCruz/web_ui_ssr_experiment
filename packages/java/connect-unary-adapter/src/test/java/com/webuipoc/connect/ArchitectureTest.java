package com.webuipoc.connect;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

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

    // AGENTS.md service split: the adapter is service-agnostic. It must never depend on a concrete service's business
    // logic — that would couple the reusable Connect machinery to one service and break its "dispatch any service" job.
    @ArchTest
    static final ArchRule adapter_stays_service_agnostic = noClasses()
            .should()
            .dependOnClassesThat()
            .resideInAPackage("com.webuipoc.businesslogic..")
            .because("the Connect-unary adapter dispatches any gRPC ServerServiceDefinition and must stay "
                    + "service-agnostic — no dependency on a concrete service's business logic");
}
