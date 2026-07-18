{
  perSystem =
    { pkgs, ... }:
    let
      # ── STUB (honest) — the Java reactor is NOT yet a pure Nix build ───────
      # These packages evaluate (so `nix flake check --no-build` passes) but fail
      # loudly at BUILD time with the precise remaining work, rather than faking an
      # artifact. What blocks a real `maven.buildMavenPackage` today:
      #
      #  1. buf-generated Java sources prerequisite. business-logic-java compiles
      #     services/business-logic-java/generated-sources/{protobuf,grpc}, produced
      #     by packages.rpc-gen (see nix/codegen.nix, its `/java` output). Wiring:
      #     copy ${config.packages.rpc-gen}/java into generated-sources/ before the
      #     maven build. (Ready — just needs threading in.)
      #
      #  2. jOOQ codegen offline-repo gap (the hard one). At generate-sources the
      #     pom runs exec-maven-plugin → scripts/jooq-codegen.sh, which starts an
      #     ephemeral postgres (initdb/pg_ctl — fine in a sandbox with loopback and
      #     postgresql_17 on PATH) and then invokes a NESTED `mvn -Pjooq-codegen
      #     org.flywaydb:flyway-maven-plugin:migrate org.jooq:jooq-codegen-maven:generate`.
      #     That nested mvn does NOT inherit the outer buildMavenPackage's
      #     `-o -Dmaven.repo.local=…`, so in the sealed offline phase-2 it tries to
      #     resolve the flyway + jooq-codegen plugins (and their deps) from the
      #     network and fails. Closing it needs the jooq-codegen profile's plugin
      #     closure pre-populated into the offline .m2 — via buildMavenPackage's
      #     `manualMvnArtifacts`/`buildOffline` machinery, and MAVEN_ARGS threaded
      #     into jooq-codegen.sh pointing the nested mvn at that same repo. This is
      #     the seam design-note gap 2 / task 2pk.6 owns; sizing it out here.
      #
      #  3. mvnHash. Once (1)+(2) build, the phase-1 FOD hash (`mvnHash`) must be
      #     pinned (fakeHash → read the mismatch), and it changes on ANY dep/plugin
      #     version bump.
      #
      # Shape for the follow-up (packages-java.nix, once 2pk.6 lands):
      #
      #   reactor = pkgs.maven.buildMavenPackage {
      #     pname = "business-logic-java-reactor";
      #     version = "0.0.1-SNAPSHOT";
      #     src = <reactor: pom.xml + packages/java + services/business-logic-java>;
      #     mvnHash = "sha256-…";              # pin after first build
      #     buildOffline = true;
      #     manualMvnArtifacts = [ /* flyway-maven-plugin, jooq-codegen-maven, … */ ];
      #     nativeBuildInputs = [ pkgs.jdk25 pkgs.postgresql_17 ];
      #     preBuild = "cp -R ${config.packages.rpc-gen}/java/. services/business-logic-java/generated-sources/";
      #     mvnParameters = "-pl packages/java/connect-unary-adapter,services/business-logic-java";
      #     installPhase = "install target/business-logic-java.jar + target/libs";
      #   };
      #
      # connect-unary-adapter (jar, com.webuipoc:connect-unary-adapter) falls out
      # of the same reactor build — expose it as a second package selecting that
      # module's target/.
      stub =
        name: reason:
        pkgs.runCommand "${name}-STUB" { } ''
          echo "==============================================================="  >&2
          echo "  packages.${name} is a STUB — not yet a pure Nix build."         >&2
          echo "  ${reason}"                                                       >&2
          echo "  See nix/packages-java.nix + nix/README.md for the exact"        >&2
          echo "  remaining work (buf-java gen wiring, jOOQ offline-repo,"        >&2
          echo "  mvnHash pinning). Blocked on task 2pk.6."                        >&2
          echo "==============================================================="  >&2
          exit 1
        '';
    in
    {
      packages.business-logic-java = stub "business-logic-java" "jOOQ codegen resolves flyway/jooq plugins online in a nested mvn (offline-repo gap).";
      packages.connect-unary-adapter = stub "connect-unary-adapter" "Built by the same reactor as business-logic-java, which is stubbed.";
    };
}
