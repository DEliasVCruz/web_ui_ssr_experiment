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
      # Only the inputs `buf generate` + wrap-jsonschema.ts actually read. Keeping
      # the source tight means edits elsewhere don't invalidate the codegen hash.
      src = lib.fileset.toSource {
        root = ../.;
        fileset = lib.fileset.unions [
          ../proto
          ../buf.yaml
          ../buf.gen.yaml
          ../buf.lock
          ../scripts/wrap-jsonschema.ts
          ../packages/rpc/package.json
        ];
      };
    in
    {
      # ── packages.rpc-gen — `bun run generate` in a derivation ─────────────
      # = buf generate (protoc-gen-es + connect-query from node_modules/.bin,
      # protoc-gen-jsonschema + protoc-gen-grpc-java + protoc builtin java from
      # nixpkgs) followed by scripts/wrap-jsonschema.ts.
      #
      # FIXED-OUTPUT: buf must fetch the buf.build/bufbuild/protovalidate BSR
      # module named in buf.lock (network). Modelling rpc-gen as an FOD keeps it
      # reproducible under a sealed sandbox (CI) — the generated code is fully
      # deterministic. Bump `outputHash` whenever the proto, buf config/lock, the
      # plugins, or wrap-jsonschema.ts change (workflow: set to lib.fakeHash, run
      # `nix build .#rpc-gen`, paste the "got:" hash — see nix/README.md).
      packages.rpc-gen = pkgs.stdenv.mkDerivation {
        pname = "web-ui-rpc-gen";
        version = "0.0.1";
        inherit src;

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
          # protoc-gen-connect-query) by name on PATH, exactly as `bun run generate`
          # does via node_modules/.bin.
          export PATH="${config.packages.node-modules}/node_modules/.bin:$PATH"

          buf generate
          bun run scripts/wrap-jsonschema.ts
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
        outputHash = "sha256-98yRVPp2jIo5uTBxL5j+yDbKjVw/EUCdXZS6O3gjMFg=";
      };
    };
}
