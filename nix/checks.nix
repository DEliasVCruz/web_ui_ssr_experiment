{
  perSystem =
    {
      pkgs,
      config,
      lib,
      ...
    }:
    let
      # Whole tracked source tree (git-filtered: node_modules/gen/dist are gitignored
      # and injected below). Shared by the repo-wide lint checks.
      fullSrc = lib.fileset.toSource {
        root = ../.;
        fileset = ../.;
      };

      # Assemble a runnable de-workspaced tree (source + the per-unit node_modules
      # FODs + generated rpc code + the injected @web-ui-poc/rpc package), then run
      # `cmd` from the repo root with the tooling toolchain on PATH.
      #
      # De-workspaced (5ae): there is NO root node_modules. Each unit has its own —
      #   * tooling/node_modules       → biome/eslint/knip/syncpack/depcruise + plugins
      #   * packages/rpc/node_modules  → buf codegen plugins + @bufbuild/protobuf
      #   * services/web-ui-ssr/node_modules → the app's deps
      # web-ui-ssr's node_modules/@web-ui-poc/rpc is injected (the nix rpc package),
      # mirroring the dev-loop postinstall symlink. All committed locks → PURE.
      mkRepoCheck =
        {
          name,
          cmd,
          extraInputs ? [ ],
        }:
        pkgs.stdenv.mkDerivation {
          inherit name;
          src = fullSrc;
          nativeBuildInputs = [
            pkgs.bun
            pkgs.nodejs_22
          ]
          ++ extraInputs;
          dontConfigure = true;
          buildPhase = ''
            runHook preBuild
            export HOME="$TMPDIR"

            # Restore each unit's node_modules from its FOD.
            cp -R ${config.packages.tooling-node-modules}/node_modules tooling/node_modules
            cp -R ${config.packages.rpc-node-modules}/node_modules packages/rpc/node_modules
            cp -R ${config.packages.web-ui-ssr-node-modules}/node_modules services/web-ui-ssr/node_modules
            chmod -R u+w tooling/node_modules packages/rpc/node_modules services/web-ui-ssr/node_modules

            # Generated rpc TS the @web-ui-poc/rpc package exports.
            mkdir -p packages/rpc/gen
            cp -R ${config.packages.rpc-gen}/ts/. packages/rpc/gen/
            chmod -R u+w packages/rpc/gen

            # Inject the nix-built @web-ui-poc/rpc over bun's file: copy (mirrors the
            # dev postinstall symlink). No bun workspace resolution.
            rm -rf services/web-ui-ssr/node_modules/@web-ui-poc/rpc
            mkdir -p services/web-ui-ssr/node_modules/@web-ui-poc
            cp -R ${config.packages.rpc} services/web-ui-ssr/node_modules/@web-ui-poc/rpc
            chmod -R u+w services/web-ui-ssr/node_modules/@web-ui-poc/rpc

            # Repo-wide lint binaries come from the tooling unit.
            export PATH="$PWD/tooling/node_modules/.bin:$PATH"

            # Panda's generated styled-system/ is a source input the web-ui-ssr TS
            # imports; type-aware linters (ci-eslint) resolve `error`-typed values
            # without it. Regenerate it exactly as the package `prepare` script does.
            ( cd services/web-ui-ssr && ./node_modules/.bin/panda codegen --clean )

            ${cmd}

            runHook postBuild
          '';
          installPhase = "touch $out";
        };
    in
    {
      checks = {
        # ── Buildable packages surfaced as checks ──────────────────────────
        tooling-node-modules = config.packages.tooling-node-modules;
        rpc-node-modules = config.packages.rpc-node-modules;
        web-ui-ssr-node-modules = config.packages.web-ui-ssr-node-modules;
        rpc-gen = config.packages.rpc-gen;
        web-ui-ssr = config.packages.web-ui-ssr;

        # De-reactored Java units (517): each builds standalone. The adapter jar is
        # a plain FOD build; business-logic-java injects it (pre-built) into its
        # offline .m2 and runs the hermetic jOOQ codegen. Both are arch-portable.
        connect-unary-adapter = config.packages.connect-unary-adapter;
        business-logic-java = config.packages.business-logic-java;

        # ── Repo-wide lint checks (mirror the devenv ci:* tasks) ───────────
        # ci-proto-breaking is intentionally NOT a check: `buf breaking --against
        # .git#branch=main` needs the git history, which a sealed check derivation
        # does not have. It stays a devenv task (same impurity class as ci:e2e).
        ci-biome = mkRepoCheck {
          name = "ci-biome";
          cmd = "biome check . --config-path tooling/biome/ci.json";
        };
        ci-eslint = mkRepoCheck {
          name = "ci-eslint";
          cmd = "eslint --config tooling/eslint/ci.ts";
        };
        # De-workspaced hygiene: syncpack (the single authoritative version
        # enforcer), per-unit knip (unused files/exports/deps — one run per unit
        # since knip needs a package.json root and there is no longer a workspace
        # root), and dependency-cruiser (module-boundary / import-direction). sherif
        # was dropped: it is a bun-workspace linter with no non-workspace mode.
        ci-hygiene = mkRepoCheck {
          name = "ci-hygiene";
          cmd = ''
            syncpack lint
            ( cd tooling && knip )
            ( cd packages/rpc && knip )
            ( cd services/web-ui-ssr && knip )
            depcruise services packages --config .dependency-cruiser.cjs
          '';
        };
      };
    };
}
