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
      # and injected below). Shared by the workspace lint checks.
      fullSrc = lib.fileset.toSource {
        root = ../.;
        fileset = ../.;
      };

      # Assemble a runnable workspace (source + node_modules FOD + generated rpc
      # code), then run `cmd`. Reuses the same restore recipe as the TS build.
      # NOTE: depends on the node_modules FOD, so building these checks needs
      # `nix build --impure` (bun.lock is gitignored — see nix/packages-ts.nix).
      mkWorkspaceCheck =
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
            cp -R ${config.packages.node-modules}/node_modules ./node_modules
            chmod -R u+w ./node_modules
            for d in packages/rpc services/web-ui-ssr; do
              if [ -d "${config.packages.node-modules}/$d/node_modules" ]; then
                mkdir -p "$d"
                cp -R "${config.packages.node-modules}/$d/node_modules" "$d/node_modules"
                chmod -R u+w "$d/node_modules"
              fi
            done
            mkdir -p packages/rpc/gen
            cp -R ${config.packages.rpc-gen}/ts/. packages/rpc/gen/
            chmod -R u+w packages/rpc/gen
            export PATH="$PWD/node_modules/.bin:$PATH"

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
        # (Realized only under `nix build --impure` / `nix flake check --impure`;
        # they evaluate cleanly under `nix flake check --no-build`.)
        node-modules = config.packages.node-modules;
        rpc-gen = config.packages.rpc-gen;
        web-ui-ssr = config.packages.web-ui-ssr;

        # ── Pure workspace lint checks (mirror the devenv ci:* tasks) ──────
        # ci-proto-breaking is intentionally NOT a check: `buf breaking --against
        # .git#branch=main` needs the git history, which a sealed check derivation
        # does not have. It stays a devenv task (and can become a `nix run` app at
        # cutover), same impurity class as ci:e2e.
        ci-biome = mkWorkspaceCheck {
          name = "ci-biome";
          cmd = "biome check . --config-path tooling/biome/ci.json";
        };
        ci-eslint = mkWorkspaceCheck {
          name = "ci-eslint";
          cmd = "eslint --config tooling/eslint/ci.ts";
        };
        ci-hygiene = mkWorkspaceCheck {
          name = "ci-hygiene";
          cmd = ''
            syncpack lint
            sherif -r multiple-dependency-versions -r unsync-similar-dependencies -r packages-without-package-json --fail-on-warnings
            knip
            depcruise services packages --config .dependency-cruiser.cjs
          '';
        };
      };
    };
}
