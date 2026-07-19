{
  perSystem =
    {
      pkgs,
      config,
      lib,
      repoTools,
      ...
    }:
    let
      # ── packages/rpc manifests (self-contained: own package.json + bun.lock) ──
      # De-workspaced (5ae): bun.lock is COMMITTED per-unit, so this FOD is PURE
      # (no --impure / $PWD read). rpc's install brings the buf codegen plugins
      # (protoc-gen-es, protoc-gen-connect-query) + @bufbuild/protobuf.
      rpcManifests = lib.fileset.toSource {
        root = ./..;
        fileset = lib.fileset.unions [
          ../package.json
          ../bun.lock
        ];
      };

      # Source `buf generate` + wrap-jsonschema.ts actually read. Kept tight so
      # edits elsewhere don't invalidate the codegen hash.
      genSrc = lib.fileset.toSource {
        root = ../../..;
        fileset = lib.fileset.unions [
          ../../../proto
          ../../../buf.yaml
          ../../../buf.gen.yaml
          ../../../buf.lock
          ../scripts/wrap-jsonschema.ts
          ../package.json
        ];
      };
    in
    {
      # ── packages.rpc-node-modules — packages/rpc's own node_modules FOD ───
      # `bun install --frozen-lockfile --ignore-scripts` in packages/rpc. Provides
      # the buf codegen plugins on node_modules/.bin for rpc-gen. PURE (committed
      # lock). FIXED-OUTPUT: bun fetches from the network, pinned by outputHash.
      packages.rpc-node-modules = pkgs.stdenv.mkDerivation {
        pname = "rpc-node-modules";
        version = "0.0.1";
        dontUnpack = true;
        # A node_modules FOD must be reference-free; skip fixup (patchShebangs would
        # rewrite bundled .sh shebangs to the nix-store bash, which FODs may not reference).
        dontFixup = true;
        nativeBuildInputs = [ pkgs.bun ];

        buildPhase = ''
          runHook preBuild
          export HOME="$TMPDIR"
          cp -R ${rpcManifests}/. ./ws
          chmod -R u+w ./ws
          cd ws
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
        outputHash = "sha256-7ulEd1qwq2uU8uheG7ksCTly8lktAUH1xR6cV/0P6GA=";
      };

      # ── packages.rpc-gen — `bun run generate` in a derivation ─────────────
      # = buf generate (protoc-gen-es + connect-query from rpc's node_modules/.bin,
      # protoc-gen-jsonschema + protoc-gen-grpc-java + protoc builtin java from
      # nixpkgs) followed by packages/rpc/scripts/wrap-jsonschema.ts.
      #
      # FIXED-OUTPUT: buf must fetch the buf.build/bufbuild/protovalidate BSR
      # module named in buf.lock (network). The generated code is fully
      # deterministic. Bump `outputHash` whenever the proto, buf config/lock, the
      # plugins, or wrap-jsonschema.ts change (workflow: set to lib.fakeHash, run
      # `nix build .#rpc-gen`, paste the "got:" hash — see nix/README.md).
      packages.rpc-gen = pkgs.stdenv.mkDerivation {
        pname = "web-ui-rpc-gen";
        version = "0.0.1";
        src = genSrc;

        nativeBuildInputs = [
          pkgs.bun
          pkgs.nodejs_22
          pkgs.buf
          pkgs.protobuf # protoc, for `protoc_builtin: java`
          pkgs.protoc-gen-grpc-java
          repoTools.protoc-gen-jsonschema
        ];

        dontConfigure = true;

        buildPhase = ''
          runHook preBuild
          export HOME="$TMPDIR"

          # buf resolves the node-based `local:` plugins (protoc-gen-es,
          # protoc-gen-connect-query) by name on PATH, exactly as the `generate`
          # script does via packages/rpc/node_modules/.bin.
          export PATH="${config.packages.rpc-node-modules}/node_modules/.bin:$PATH"

          buf generate
          bun run packages/rpc/scripts/wrap-jsonschema.ts
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/ts" "$out/java"
          # TS + JSON Schema outputs (consumed by packages/rpc/gen).
          cp -R packages/rpc/gen/. "$out/ts/"
          # Java protobuf + gRPC sources (consumed by the business-logic-java build).
          cp -R services/business-logic-java/generated-sources/. "$out/java/"
          runHook postInstall
        '';

        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-8nKiyHjdruvQl9tIUTtRBhS3pEFcUrCRwr7cOEneCUg=";
      };

      # ── packages.rpc — the importable @web-ui-poc/rpc package (pure) ───────
      # package.json + the buf-generated TS under gen/. This is exactly the
      # content services/web-ui-ssr's node_modules/@web-ui-poc/rpc must hold; the
      # web-ui-ssr build/checks inject it (replacing the bun `file:` copy). In the
      # devenv dev loop the same slot is a live symlink created by web-ui-ssr's
      # postinstall — NO bun workspace resolution in either world.
      packages.rpc = pkgs.runCommand "web-ui-poc-rpc" { } ''
        mkdir -p "$out/gen"
        cp ${../package.json} "$out/package.json"
        cp -R ${config.packages.rpc-gen}/ts/. "$out/gen/"
      '';
    };
}
