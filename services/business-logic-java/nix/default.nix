{
  perSystem =
    {
      pkgs,
      config,
      lib,
      ...
    }:
    let
      # ── business-logic-java as a standalone pure Nix build ─────────────────
      # De-reactored (task 517): this unit no longer builds inside a Maven reactor. Its
      # own pom (packaging=jar, no <parent>) imports the build-bom BOM for shared
      # dependency versions and depends on connect-unary-adapter as a PLAIN artifact.
      # buildMavenPackage runs a single-module `mvn package -f
      # services/business-logic-java/pom.xml`.
      #
      # TWO SEAMS:
      #
      # 1) build-bom (com.webuipoc:build-bom, a local pom-only SNAPSHOT) is imported by
      #    this pom's dependencyManagement (scope=import), so it must be in the local
      #    repo before `mvn package`. `mvn -N install` its pom into the shared repo.
      #
      # 2) connect-unary-adapter — the ADAPTER BRIDGE. In the reactor world the adapter
      #    was rebuilt from source in-session; here it is a SEPARATE Nix derivation
      #    (packages.connect-unary-adapter) and we inject its PRE-BUILT jar + pom into
      #    the offline .m2 with `install:install-file`. So business-logic-java consumes
      #    the adapter as an explicit artifact dependency, NOT via reactor resolution.
      #
      # THE HARD SEAM — jOOQ codegen (design-note gap 2 / task 2pk.6). At
      # generate-sources this pom runs exec-maven-plugin → scripts/jooq-codegen.sh,
      # which starts an EPHEMERAL postgres over loopback (initdb/pg_ctl — NO docker
      # socket, so sandbox-legal), applies the module's Flyway migrations, and runs
      # jOOQ codegen via a NESTED `mvn -Pjooq-codegen flyway:migrate jooq-codegen:generate`.
      # That nested mvn does NOT inherit the outer buildMavenPackage flags, so it would
      # resolve the flyway + jooq-codegen plugins (and build-bom) from the network —
      # fatal in the sealed offline phase-2.
      #
      # SOLUTION (unchanged from the reactor build, no manualMvnArtifacts guessing):
      # keep buildOffline=false so the phase-1 FOD runs the FULL `mvn package` ONLINE —
      # the identical build phase-2 runs — so the FOD's .m2 provably contains EVERY
      # artifact the offline build needs, jOOQ/Flyway profile plugins included. We only
      # point the nested mvn at the SAME local repo per phase via $MAVEN_ARGS (the
      # script forwards it into the nested mvn; Maven 3.9+ reads it natively):
      #   * phase-1 FOD (network on) → MAVEN_ARGS="-Dmaven.repo.local=$out/.m2"
      #   * phase-2 build (sealed)   → MAVEN_ARGS="-o -Dmaven.repo.local=$mvnDeps/.m2"
      #
      # buf-generated Java sources (protobuf + gRPC stubs) are gitignored; both phases
      # copy them from packages.rpc-gen's /java output into
      # services/business-logic-java/generated-sources/ before the build.
      #
      # TESTS. doCheck=false (-DskipTests): the Java suite (surefire DB-repository tests
      # + failsafe *IT) boots Testcontainers postgres, which needs a podman/docker
      # socket the Nix sandbox lacks. Test SOURCES still compile. Execution stays in the
      # impure CI path (`nix run .#java-verify`, i.e. `mvn verify` under the podman machine).
      #
      # ARCH. Java is arch-portable — builds and runs on aarch64-darwin and x86_64-linux.

      # git-tracked ∩ (service unit + build-bom pom + .mvn). The adapter SOURCE is NOT
      # included — the adapter is injected as a pre-built jar (bridge above). gitignored
      # generated-sources/ + target/ are excluded automatically, keeping mvnHash stable.
      serviceSrc = lib.fileset.toSource {
        root = ../../..;
        fileset = lib.fileset.intersection (lib.fileset.gitTracked ../../..) (
          lib.fileset.unions [
            ../../../.mvn
            ../../../packages/java/build-bom/pom.xml
            ../. # services/business-logic-java
          ]
        );
      };

      # patchShebangs the jooq-codegen.sh helper (exec-maven-plugin runs it at
      # generate-sources). Its `#!/usr/bin/env bash` shebang is fine on darwin
      # (nix.conf `sandbox = false` → host /usr/bin/env) but the Linux nix
      # sandbox has NO /usr/bin/env, so realizing this build through the
      # linux-builder failed with `Cannot run program …/jooq-codegen.sh: Exec
      # failed, error: 2` (1vl). Rewriting to the absolute nix-store bash makes it
      # cross-platform; the produced .m2/jar are unaffected so mvnHash is stable.
      # Runs in BOTH the phase-1 FOD and the sealed phase-2 (both hit codegen).
      patchScripts = "patchShebangs services/business-logic-java/scripts";

      # Copy the buf-generated Java sources (rpc-gen /java) into place. Shared by both
      # the FOD (compiles them online) and the sealed build.
      copyBufJava = ''
        mkdir -p services/business-logic-java/generated-sources
        cp -R ${config.packages.rpc-gen}/java/. services/business-logic-java/generated-sources/
        chmod -R u+w services/business-logic-java/generated-sources
      '';

      adapter = config.packages.connect-unary-adapter;

      # Pre-install build-bom (pom-only) + inject the pre-built adapter jar/pom into the
      # shared local repo so this pom's scope=import BOM and adapter dependency resolve,
      # and so the nested jooq-codegen mvn can read them too. Repo + offline supplied by
      # $MAVEN_ARGS (exported just before this runs).
      installDeps = ''
        mvn -B -N install -f packages/java/build-bom/pom.xml
        # The adapter derivation emits its jar under a stable version-less name, so no
        # version coordinate is duplicated here; install:install-file reads the real GAV
        # from -DpomFile.
        mvn -B install:install-file \
          -Dfile=${adapter}/connect-unary-adapter.jar \
          -DpomFile=${adapter}/pom.xml
      '';

      mvnParams = "-f services/business-logic-java/pom.xml";
    in
    {
      packages.business-logic-java = pkgs.maven.buildMavenPackage {
        pname = "business-logic-java";
        version = "0.0.1-SNAPSHOT";
        src = serviceSrc;
        mvnParameters = mvnParams;

        # Bind the whole build (outer + nested mvn) to JDK 25.
        mvnJdk = pkgs.jdk25;

        # postgres binaries for jooq-codegen.sh (initdb/pg_ctl/createdb) — needed in
        # BOTH phases (both run generate-sources). stripJavaArchivesHook zeroes the zip
        # mtimes in the OUTPUT jars (business-logic-java.jar + libs/*.jar) at fixupPhase,
        # so the derivation is bit-reproducible (the FOD sets dontFixup → hook is a
        # no-op there; FOD determinism handled by the postInstall scrub below).
        nativeBuildInputs = [
          pkgs.jdk25
          pkgs.postgresql_17
          pkgs.stripJavaArchivesHook
        ];

        # Skip test EXECUTION (Testcontainers needs a container daemon); see header.
        doCheck = false;

        # ── phase-1 (FOD, network on) ──────────────────────────────────────
        mvnFetchExtraArgs = {
          preBuild = ''
            export MAVEN_ARGS="-Dmaven.repo.local=$out/.m2"
            ${patchScripts}
            ${installDeps}
            ${copyBufJava}
          '';
          # FOD DETERMINISM. The build-bom install + adapter install:install-file write
          # non-reproducible files under com/webuipoc (the adapter SNAPSHOT jar + 4×
          # maven-metadata-local.xml wall-clock stamps) that buildMavenPackage's own
          # prune does not strip. Delete the whole locally-installed group plus any
          # stray *-local metadata after the prune. Phase-2 re-injects build-bom +
          # adapter into its writable .m2 copy (afterDepsSetup), so nothing the offline
          # build needs is lost. Proven: two `nix build --rebuild` reproduce this mvnHash.
          postInstall = ''
            rm -rf "$out/.m2/com/webuipoc"
            find "$out/.m2" -name 'maven-metadata-local.xml' -delete
          '';
        };
        # Pin after the first build (fakeHash → read the got: value). Deterministic (see
        # postInstall); .m2 is downloaded artifacts, portable across build hosts.
        mvnHash = "sha256-etTXRWL1MH8lEVjt3N9w9SNAkr/lIijElT1t6UTglmo=";

        # ── phase-2 (sealed, offline) ──────────────────────────────────────
        # preBuild copies buf-java again; afterDepsSetup (after $mvnDeps is set, before
        # the outer mvn) points at the copied offline repo and re-injects build-bom +
        # the adapter so the outer AND the nested jooq-codegen mvn resolve them offline.
        preBuild = ''
          ${patchScripts}
          ${copyBufJava}
        '';
        afterDepsSetup = ''
          export MAVEN_ARGS="-o -Dmaven.repo.local=$mvnDeps/.m2"
          ${installDeps}
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/libs"
          # Runnable server jar + its Class-Path libs/ (self-contained: includes
          # connect-unary-adapter.jar via copy-dependencies includeScope=runtime).
          cp services/business-logic-java/target/business-logic-java.jar "$out/business-logic-java.jar"
          cp -R services/business-logic-java/target/libs/. "$out/libs/"
          runHook postInstall
        '';

        meta = {
          description = "business-logic-java runnable server jar (Helidon SE)";
          platforms = pkgs.jdk25.meta.platforms;
        };
      };
    };
}
