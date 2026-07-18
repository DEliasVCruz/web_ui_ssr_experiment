{
  perSystem =
    {
      pkgs,
      config,
      lib,
      ...
    }:
    let
      # ── The Maven reactor as a pure Nix build (buildMavenPackage) ─────────
      # Reactor: root pom (packaging=pom) → packages/java/connect-unary-adapter
      # (jar) + services/business-logic-java (runnable jar + target/libs). Both
      # jars fall out of ONE `mvn package`.
      #
      # THE HARD SEAM — jOOQ codegen (design-note gap 2 / task 2pk.6). At
      # generate-sources services/business-logic-java runs exec-maven-plugin →
      # scripts/jooq-codegen.sh, which:
      #   * starts an EPHEMERAL postgres over loopback (initdb/pg_ctl — NO docker
      #     socket, so it is sandbox-legal), applies the module's Flyway
      #     migrations, and runs jOOQ codegen against the live catalog, via a
      #     NESTED `mvn -Pjooq-codegen flyway:migrate jooq-codegen:generate`.
      # That nested mvn does NOT inherit the outer buildMavenPackage flags, so it
      # would resolve the flyway + jooq-codegen plugins from the network — fatal
      # in the sealed offline phase-2.
      #
      # SOLUTION (no manualMvnArtifacts guessing): keep buildOffline=false so the
      # phase-1 FOD runs the FULL `mvn package` ONLINE — which is the identical
      # build phase-2 runs, so the FOD's populated .m2 provably contains EVERY
      # artifact the offline build needs, jOOQ/Flyway profile plugins included.
      # We only have to point the nested mvn at the SAME local repo in each phase.
      # The script already forwards $MAVEN_ARGS into the nested mvn (and Maven 3.9+
      # reads it natively), so we export it per-phase:
      #   * phase-1 FOD (network on)  → MAVEN_ARGS="-Dmaven.repo.local=$out/.m2"
      #     — nested mvn DOWNLOADS the profile plugin closure into the FOD's .m2,
      #       where it is captured by mvnHash.
      #   * phase-2 build (sealed)    → MAVEN_ARGS="-o -Dmaven.repo.local=$mvnDeps/.m2"
      #     — nested mvn resolves those same plugins OFFLINE from the copied repo.
      # Phase-1 sets it in the fetch derivation's preBuild; phase-2 sets it in the
      # `afterDepsSetup` hook (runs after buildMavenPackage assigns $mvnDeps,
      # before the outer mvn) — see pkgs/by-name/ma/maven/build-maven-package.nix.
      #
      # buf-generated Java sources (protobuf + gRPC stubs) are gitignored; both
      # phases copy them from packages.rpc-gen's /java output into
      # services/business-logic-java/generated-sources/ before the build.
      #
      # TESTS. doCheck=false (-DskipTests): the Java suite (surefire DB-repository
      # tests AND failsafe *IT) boots Testcontainers postgres, which needs a
      # podman/docker socket the Nix sandbox does not have. Test SOURCES still
      # compile (verifies they build); execution stays in the impure CI/e2e path
      # (devenv ci:e2e + `mvn verify` under the podman machine). ArchUnit + pure
      # unit tests could run here in principle but are not separable from the
      # Testcontainers ones without surefire include filtering; deferred to 2pk.4.
      #
      # ARCH. Java is arch-portable — this builds and runs on aarch64-darwin
      # (verified via `nix build --impure .#business-logic-java`), unlike the OCI
      # images which target x86_64-linux and only realize on Linux.

      reactorSrc = lib.fileset.toSource {
        root = ../.;
        # git-tracked ∩ reactor paths: excludes the gitignored generated-sources/
        # and target/ trees automatically, keeping mvnHash stable.
        fileset = lib.fileset.intersection (lib.fileset.gitTracked ../.) (
          lib.fileset.unions [
            ../pom.xml
            ../.mvn
            ../packages/java
            ../services/business-logic-java
          ]
        );
      };

      # Copy the buf-generated Java sources (rpc-gen /java) into place. Shared by
      # both the FOD (compiles them online) and the sealed build.
      copyBufJava = ''
        mkdir -p services/business-logic-java/generated-sources
        cp -R ${config.packages.rpc-gen}/java/. services/business-logic-java/generated-sources/
        chmod -R u+w services/business-logic-java/generated-sources
      '';

      # Pre-install ONLY the connect-unary-adapter jar into the shared local repo
      # so business-logic-java's nested jooq-codegen mvn can resolve the sibling
      # SNAPSHOT. Repo + offline are supplied by $MAVEN_ARGS (exported just before
      # this runs). The quality gates (spotless/checkstyle/pmd/enforcer, all bound
      # to `verify` — which the `install` phase pulls in) are skipped: they need
      # tooling/ configs an image build has no business running, and the main
      # reactor build below stops at `package` so it never triggers them itself.
      # Skips for the quality gates bound to `verify` (which `install` triggers).
      mvnQualitySkips = "-DskipTests -Dspotless.check.skip=true -Dcheckstyle.skip=true -Dpmd.skip=true -Dcpd.skip=true -Denforcer.skip=true";
      installAdapter = ''
        # 1) The parent aggregator pom (packaging=pom) — `-N` installs ONLY it, so
        #    the adapter's descriptor (parent = web-ui-ssr-experiment-parent) is
        #    readable from the local repo when the nested mvn resolves the sibling.
        mvn -B -N install ${mvnQualitySkips}
        # 2) The adapter jar itself.
        mvn -B -pl packages/java/connect-unary-adapter install ${mvnQualitySkips}
      '';

      reactor = pkgs.maven.buildMavenPackage {
        pname = "business-logic-java-reactor";
        version = "0.0.1-SNAPSHOT";
        src = reactorSrc;

        # Bind the whole build (outer + nested mvn) to JDK 25 (release 25 sources,
        # errorprone/nullaway processors). JAVA_HOME is --set-default in the maven
        # wrapper, so env.JAVA_HOME (= mvnJdk) wins for every mvn invocation.
        mvnJdk = pkgs.jdk25;

        # postgres binaries for jooq-codegen.sh (initdb/pg_ctl/createdb) — needed
        # in BOTH phases (both run generate-sources). jdk25 for the javadoc/tools
        # the annotation processors touch. maven is auto-added by buildMavenPackage.
        nativeBuildInputs = [
          pkgs.jdk25
          pkgs.postgresql_17
        ];

        # Skip test EXECUTION (Testcontainers needs a container daemon); see above.
        doCheck = false;

        # ── phase-1 (FOD, network on) ──────────────────────────────────────
        mvnFetchExtraArgs = {
          # runHook preBuild runs this before the online `mvn package`.
          preBuild = ''
            ${copyBufJava}
            # Nested jooq-codegen mvn shares the FOD's populated local repo, so its
            # flyway + jooq-codegen plugin closure is downloaded into $out/.m2 and
            # captured by mvnHash. No -o here (phase-1 has network).
            export MAVEN_ARGS="-Dmaven.repo.local=$out/.m2"
            ${installAdapter}
          '';
        };
        # Pin after the first build (fakeHash → read the got: value). Captured on
        # aarch64-darwin; the .m2 is generated jars + downloaded artifacts, which
        # are arch-independent, so this single hash is portable to x86_64-linux.
        mvnHash = "sha256-bV/HI/BBCHL0fXywzxCIcxZgT0h9zQZA7RPGMjPVDQk=";

        # ── phase-2 (sealed, offline) ──────────────────────────────────────
        # preBuild copies buf-java again; afterDepsSetup (after $mvnDeps is set,
        # before the outer mvn) points the nested jooq-codegen mvn at the copied
        # offline repo.
        preBuild = copyBufJava;
        afterDepsSetup = ''
          export MAVEN_ARGS="-o -Dmaven.repo.local=$mvnDeps/.m2"
          ${installAdapter}
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/libs" "$out/adapter"
          # Runnable server jar + its Class-Path libs/ (self-contained: includes
          # connect-unary-adapter.jar via copy-dependencies includeScope=runtime).
          cp services/business-logic-java/target/business-logic-java.jar "$out/business-logic-java.jar"
          cp -R services/business-logic-java/target/libs/. "$out/libs/"
          # The Connect-unary adapter jar (second reactor module) for consumers.
          cp packages/java/connect-unary-adapter/target/connect-unary-adapter-*.jar "$out/adapter/"
          runHook postInstall
        '';

        meta = {
          description = "business-logic-java runnable server jar (Helidon SE) + reactor";
          platforms = pkgs.jdk25.meta.platforms;
        };
      };
    in
    {
      # ── packages.business-logic-java — runnable server jar + target/libs ──
      packages.business-logic-java = reactor;

      # ── packages.connect-unary-adapter — the adapter jar from the reactor ─
      packages.connect-unary-adapter =
        pkgs.runCommand "connect-unary-adapter"
          {
            meta.description = "Connect-unary HTTP adapter jar (com.webuipoc:connect-unary-adapter)";
          }
          ''
            mkdir -p "$out"
            cp ${reactor}/adapter/*.jar "$out/"
          '';
    };
}
