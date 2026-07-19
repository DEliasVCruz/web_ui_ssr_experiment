{
  perSystem =
    {
      pkgs,
      config,
      lib,
      system,
      ...
    }:
    let
      # ── Per-system node_modules FOD hash (1vl) ───────────────────────────
      # `bun install` fetches PLATFORM-SPECIFIC native deps (esbuild,
      # @rsbuild/core, lightningcss, playwright-core binaries), so each system
      # resolves a DIFFERENT closure → a different fixed-output hash. The image
      # is realized for aarch64-linux (podman-machine native; Daniel's 1vl
      # ruling), so that hash is captured through the linux-builder VM; the
      # darwin hash stays as first captured (2pk). x86_64-linux is kept
      # EVALUABLE (Fly parked, per 1vl) but is not a realized target — it reuses
      # a placeholder because `nix flake check --no-build --all-systems` only
      # EVALUATES (never fetches), so its hash is not verified there; realizing
      # it later just needs its own `nix build .#web-ui-ssr-node-modules` capture
      # on an x86_64-linux builder.
      nodeModulesHashes = {
        aarch64-darwin = "sha256-SJXPOJ1WgHKvtaEECeXztTIiI4OhQFz2MBUhPk8+FCE=";
        aarch64-linux = "sha256-4yxVKbRgHiuyS8gtHDv1JvSksst4xcpAUbbTrDPO/yI=";
        # Placeholder (Fly parked): not realized here; recapture on an x86_64 builder.
        x86_64-linux = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      };
      nodeModulesHash =
        nodeModulesHashes.${system}
          or (throw "web-ui-ssr-node-modules: no FOD outputHash captured for ${system}");

      # ── web-ui-ssr install inputs ────────────────────────────────────────
      # De-workspaced (5ae): web-ui-ssr is self-contained with its own
      # package.json + COMMITTED bun.lock → this FOD is PURE. packages/rpc's
      # package.json is included because web-ui-ssr depends on it via
      # `file:../../packages/rpc`; bun needs the target manifest to resolve it.
      installSrc = lib.fileset.toSource {
        root = ../../..;
        fileset = lib.fileset.unions [
          ../package.json
          ../bun.lock
          ../../../packages/rpc/package.json
        ];
      };

      # Inject the nix-built @web-ui-poc/rpc package (package.json + generated gen/)
      # over the bun `file:` copy that --ignore-scripts leaves in node_modules.
      # Shared by the build here and the lint checks (nix/checks.nix).
      injectRpc = ''
        rm -rf services/web-ui-ssr/node_modules/@web-ui-poc/rpc
        mkdir -p services/web-ui-ssr/node_modules/@web-ui-poc
        cp -R ${config.packages.rpc} services/web-ui-ssr/node_modules/@web-ui-poc/rpc
        chmod -R u+w services/web-ui-ssr/node_modules/@web-ui-poc/rpc
      '';
    in
    {
      # ── packages.web-ui-ssr-node-modules — service node_modules FOD ───────
      # `bun install --frozen-lockfile --ignore-scripts` in services/web-ui-ssr.
      # --ignore-scripts skips the postinstall
      # rpc symlink; the nix build injects the rpc package instead (injectRpc).
      # PURE (committed lock). FIXED-OUTPUT: bun fetches, pinned by outputHash.
      packages.web-ui-ssr-node-modules = pkgs.stdenv.mkDerivation {
        pname = "web-ui-ssr-node-modules";
        version = "0.0.1";
        dontUnpack = true;
        dontFixup = true;
        nativeBuildInputs = [ pkgs.bun ];

        buildPhase = ''
          runHook preBuild
          export HOME="$TMPDIR"
          cp -R ${installSrc}/. ./ws
          chmod -R u+w ./ws
          cd ws/services/web-ui-ssr
          bun install --frozen-lockfile --ignore-scripts

          # REPRODUCIBILITY: bun materializes the `file:../../packages/rpc` dep as an
          # ABSOLUTE symlink into the ephemeral build dir, which serializes into the
          # NAR and makes this FOD hash non-deterministic (--rebuild → different hash).
          # Drop the slot: every consumer (build, checks, image) injects the nix-built
          # rpc package over node_modules/@web-ui-poc/rpc anyway, and this also stops
          # the FOD from varying with packages/rpc/package.json.
          rm -rf node_modules/@web-ui-poc
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -R node_modules "$out/node_modules"
          runHook postInstall
        '';

        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = nodeModulesHash;
      };

      # ── packages.web-ui-ssr — panda codegen + rsbuild build → dist ────────
      # Pure build: consumes the node_modules FOD + the nix-built rpc package, so
      # no network. $out/dist holds the server + client bundles
      # (`bun dist/server/index.js`). PUBLIC_BUSINESS_LOGIC_URL stays at its
      # rsbuild.config.ts default here; threading a deploy value is a later task.
      packages.web-ui-ssr = pkgs.stdenv.mkDerivation {
        pname = "web-ui-ssr";
        version = "0.0.1";

        src = lib.fileset.toSource {
          root = ../../..;
          fileset = lib.fileset.unions [
            ../../../services/web-ui-ssr
            ../../../packages/rpc/package.json
            ../../../tsconfig.json
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

          cp -R ${config.packages.web-ui-ssr-node-modules}/node_modules services/web-ui-ssr/node_modules
          chmod -R u+w services/web-ui-ssr/node_modules
          ${injectRpc}

          # patchShebangs the writable node_modules bin scripts (panda, rsbuild,
          # …). Their `#!/usr/bin/env node` shebang works on darwin (nix.conf
          # `sandbox = false`) but has no /usr/bin/env in the Linux nix sandbox,
          # so realizing this build through the linux-builder died with
          # `panda: /usr/bin/env: bad interpreter` (1vl). Rewriting to the
          # absolute nix-store node makes it cross-platform; the emitted dist is
          # byte-for-byte unaffected (web-ui-ssr is not an FOD).
          patchShebangs services/web-ui-ssr/node_modules

          cd services/web-ui-ssr
          export PATH="$PWD/node_modules/.bin:$PATH"
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
