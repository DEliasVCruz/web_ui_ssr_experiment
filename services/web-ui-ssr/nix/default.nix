{
  perSystem =
    {
      pkgs,
      config,
      lib,
      ...
    }:
    let
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
      # `bun install --frozen-lockfile --ignore-scripts` in services/web-ui-ssr
      # (matches the Dockerfile deps stage). --ignore-scripts skips the postinstall
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
        outputHash = "sha256-yH0Y8hGLaIOJgx55Q5LPmMcPgF142SI+kiI79xFZoDg=";
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
