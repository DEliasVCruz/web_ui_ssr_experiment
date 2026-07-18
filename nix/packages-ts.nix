{
  perSystem =
    {
      pkgs,
      config,
      lib,
      ...
    }:
    let
      # Workspace manifests that `bun install` needs (all git-tracked).
      manifests = lib.fileset.toSource {
        root = ../.;
        fileset = lib.fileset.unions [
          ../package.json
          ../packages/rpc/package.json
          ../services/web-ui-ssr/package.json
        ];
      };

      # bun.lock is GITIGNORED in this repo (local-only convention), so it is NOT
      # part of the flake's git source tree — a pure flake eval cannot see it. We
      # read it impurely from the working directory: building the TS packages
      # therefore requires `nix build --impure` invoked from the repo root.
      #
      # Under PURE eval (e.g. `nix flake check --no-build`) getEnv returns "" so
      # `impure` is false: evaluation/instantiation still succeeds (bunLock points
      # at a tracked placeholder that is NEVER consumed), and the buildPhase
      # fails FAST with an explicit --impure pointer if the FOD is ever realized
      # without --impure — instead of dying deep in bun with InvalidLockfileVersion.
      pwd = builtins.getEnv "PWD";
      impure = pwd != "";
      bunLock = if impure then (/. + pwd) + "/bun.lock" else ../package.json;

      # Restore the FOD's captured node_modules trees (root + per-workspace) into
      # the build tree at their original relative paths.
      restoreNodeModules = ''
        cp -R ${config.packages.node-modules}/node_modules ./node_modules
        chmod -R u+w ./node_modules
        for d in packages/rpc services/web-ui-ssr; do
          if [ -d "${config.packages.node-modules}/$d/node_modules" ]; then
            mkdir -p "$d"
            cp -R "${config.packages.node-modules}/$d/node_modules" "$d/node_modules"
            chmod -R u+w "$d/node_modules"
          fi
        done
      '';
    in
    {
      # ── packages.node-modules — the vendored node_modules FOD ─────────────
      # `bun install --frozen-lockfile --ignore-scripts` (matches the Dockerfile's
      # deps stage). FIXED-OUTPUT: bun fetches from the network, the result is
      # pinned by outputHash. Bump the hash on any bun.lock change (workflow in
      # nix/README.md). Requires `--impure` (see bunLock above).
      packages.node-modules = pkgs.stdenv.mkDerivation {
        pname = "web-ui-node-modules";
        version = "0.0.1";
        dontUnpack = true;
        # A node_modules FOD must be reference-free. Skip stdenv fixup — otherwise
        # patchShebangs rewrites the `.sh` shebangs bundled in packages (playwright-core,
        # pino, ajv…) to the build's nix-store bash, and FODs may not reference the store.
        dontFixup = true;
        nativeBuildInputs = [ pkgs.bun ];

        # "1" only under `--impure` (getEnv sees $PWD); "" under pure eval.
        impureLock = if impure then "1" else "";

        buildPhase = ''
          runHook preBuild
          if [ -z "$impureLock" ]; then
            echo "ERROR: bun.lock is gitignored and not visible to a pure build." >&2
            echo "       Run 'nix build --impure' from the repo root."            >&2
            exit 1
          fi
          export HOME="$TMPDIR"
          cp -R ${manifests}/. ./ws
          chmod -R u+w ./ws
          cp ${bunLock} ./ws/bun.lock
          cd ws
          bun install --frozen-lockfile --ignore-scripts
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -R node_modules "$out/node_modules"
          for d in packages/rpc services/web-ui-ssr; do
            if [ -d "$d/node_modules" ]; then
              mkdir -p "$out/$d"
              cp -R "$d/node_modules" "$out/$d/node_modules"
            fi
          done
          runHook postInstall
        '';

        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-tRtTsNYe8rQK//hj9vbcLEEM5dbTqEJXSQfXLuK4fiA=";
      };

      # ── packages.web-ui-ssr — panda codegen + rsbuild build → dist ────────
      # Pure build: consumes the node_modules FOD + the rpc-gen FOD, so no network.
      # $out/dist holds the server + client bundles (`bun dist/server/index.js`).
      # PUBLIC_BUSINESS_LOGIC_URL is left at its rsbuild.config.ts default here;
      # threading a deploy-time value is a later (image) task.
      packages.web-ui-ssr = pkgs.stdenv.mkDerivation {
        pname = "web-ui-ssr";
        version = "0.0.1";

        src = lib.fileset.toSource {
          root = ../.;
          fileset = lib.fileset.unions [
            ../services/web-ui-ssr
            ../packages/rpc
            ../package.json
            ../tsconfig.json
          ];
        };

        nativeBuildInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];

        dontConfigure = true;

        buildPhase = ''
          runHook preBuild
          export HOME="$TMPDIR"
          export NODE_ENV=production

          ${restoreNodeModules}

          # Place the generated rpc code (TS + JSON Schema) that @web-ui-poc/rpc exports.
          mkdir -p packages/rpc/gen
          cp -R ${config.packages.rpc-gen}/ts/. packages/rpc/gen/
          chmod -R u+w packages/rpc/gen

          cd services/web-ui-ssr
          export PATH="$PWD/node_modules/.bin:$PWD/../../node_modules/.bin:$PATH"
          panda codegen --clean
          rsbuild build
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -R dist "$out/dist"
          runHook postInstall
        '';
      };
    };
}
