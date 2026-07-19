{
  perSystem =
    {
      pkgs,
      lib,
      ...
    }:
    let
      # ── connect-unary-adapter as a standalone pure Nix build ───────────────
      # De-reactored (task 517): this unit no longer builds inside a Maven reactor.
      # Its own pom (packaging=jar, no <parent>) imports the build-bom BOM for shared
      # dependency versions; buildMavenPackage runs a single-module `mvn package -f
      # packages/java/connect-unary-adapter/pom.xml`.
      #
      # THE ONLY SEAM — build-bom (com.webuipoc:build-bom, a local pom-only SNAPSHOT)
      # is imported by this pom's dependencyManagement (scope=import), so it must be in
      # the local repo BEFORE `mvn package` resolves the model. It is not on the
      # network, so we `mvn -N install` its pom into the SAME repo each phase uses
      # (repo supplied via $MAVEN_ARGS, exported just before). This mirrors how the old
      # reactor pre-installed its parent pom.
      #
      # No jOOQ, no postgres, no buf-generated sources here — the adapter is
      # service-agnostic and has zero generated sources (unlike business-logic-java).
      #
      # TESTS. doCheck=false (-DskipTests): the adapter's 28 unit/ArchUnit tests are
      # pure and COULD run in the sandbox, but are kept in the impure CI/devenv path
      # for symmetry with business-logic-java (whose Testcontainers tests need a
      # daemon). Test sources still compile.
      #
      # ARCH. Java is arch-portable — builds and runs on aarch64-darwin and
      # x86_64-linux.

      # git-tracked ∩ (adapter unit + build-bom pom + .mvn). Rooted at the repo so
      # .mvn (errorprone add-exports) and the shared build-bom pom are in the tree;
      # gitignored target/ is excluded automatically, keeping mvnHash stable.
      adapterSrc = lib.fileset.toSource {
        root = ../../../..;
        fileset = lib.fileset.intersection (lib.fileset.gitTracked ../../../..) (
          lib.fileset.unions [
            ../../../../.mvn
            ../../build-bom/pom.xml
            ../. # packages/java/connect-unary-adapter
          ]
        );
      };

      # Pre-install ONLY the build-bom pom into the shared local repo so this pom's
      # scope=import resolves. Repo + offline come from $MAVEN_ARGS (exported just
      # before this runs). build-bom is pom-only with no plugins, so nothing to skip.
      installBom = ''
        mvn -B -N install -f packages/java/build-bom/pom.xml
      '';

      mvnParams = "-f packages/java/connect-unary-adapter/pom.xml";
    in
    {
      packages.connect-unary-adapter = pkgs.maven.buildMavenPackage {
        pname = "connect-unary-adapter";
        version = "0.0.1-SNAPSHOT";
        src = adapterSrc;
        mvnParameters = mvnParams;

        # Bind the whole build to JDK 25 (release 25 sources, errorprone/nullaway).
        mvnJdk = pkgs.jdk25;

        # stripJavaArchivesHook zeroes the zip mtimes in the OUTPUT jar at fixupPhase,
        # so the derivation is bit-reproducible (the FOD sets dontFixup, so the hook is
        # a no-op there — FOD determinism is handled by the postInstall scrub below).
        nativeBuildInputs = [
          pkgs.jdk25
          pkgs.stripJavaArchivesHook
        ];

        # Skip test EXECUTION; test sources still compile. See header.
        doCheck = false;

        # ── phase-1 (FOD, network on) ──────────────────────────────────────
        mvnFetchExtraArgs = {
          preBuild = ''
            export MAVEN_ARGS="-Dmaven.repo.local=$out/.m2"
            ${installBom}
          '';
          # FOD DETERMINISM. The build-bom `mvn install` writes non-reproducible files
          # under com/webuipoc (maven-metadata-local.xml wall-clock stamps) that
          # buildMavenPackage's own prune does not strip. Delete the whole
          # locally-installed group plus any stray *-local metadata after the prune.
          # Phase-2 re-installs build-bom into its writable .m2 copy (afterDepsSetup),
          # so nothing the offline build needs is lost.
          postInstall = ''
            rm -rf "$out/.m2/com/webuipoc"
            find "$out/.m2" -name 'maven-metadata-local.xml' -delete
          '';
        };
        # Pin after the first build (fakeHash → read the got: value). Deterministic
        # (see postInstall); .m2 is downloaded artifacts, portable across build hosts.
        mvnHash = "sha256-FrKvihvbDzkyOKPDiGb6Aqrpazpxt95DgEM4BYvYcZw=";

        # ── phase-2 (sealed, offline) ──────────────────────────────────────
        afterDepsSetup = ''
          export MAVEN_ARGS="-o -Dmaven.repo.local=$mvnDeps/.m2"
          ${installBom}
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          # The adapter jar + its pom, both consumed by the business-logic-java build
          # (injected into that unit's offline .m2 via install:install-file).
          cp packages/java/connect-unary-adapter/target/connect-unary-adapter-*.jar "$out/"
          cp packages/java/connect-unary-adapter/pom.xml "$out/pom.xml"
          runHook postInstall
        '';

        meta = {
          description = "Connect-unary HTTP adapter jar (com.webuipoc:connect-unary-adapter)";
          platforms = pkgs.jdk25.meta.platforms;
        };
      };
    };
}
