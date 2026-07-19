{
  perSystem =
    { pkgs, lib, ... }:
    let
      # Repo-wide lint/hygiene toolchain manifests (biome, eslint + plugins, knip,
      # syncpack, dependency-cruiser, typescript). Self-contained unit with its own
      # COMMITTED bun.lock → this FOD is PURE.
      toolingManifests = lib.fileset.toSource {
        root = ./..;
        fileset = lib.fileset.unions [
          ../package.json
          ../bun.lock
        ];
      };
    in
    {
      # ── packages.tooling-node-modules — the lint toolchain node_modules FOD ─
      # `bun install --frozen-lockfile --ignore-scripts` in tooling/. Its
      # node_modules/.bin provides biome/eslint/knip/syncpack/depcruise for the
      # repo-wide lint checks (nix/checks.nix) and the ci-* apps (nix/apps.nix). FIXED-OUTPUT.
      packages.tooling-node-modules = pkgs.stdenv.mkDerivation {
        pname = "tooling-node-modules";
        version = "0.0.1";
        dontUnpack = true;
        dontFixup = true;
        nativeBuildInputs = [ pkgs.bun ];

        buildPhase = ''
          runHook preBuild
          export HOME="$TMPDIR"
          cp -R ${toolingManifests}/. ./ws
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
        outputHash = "sha256-czCoZ8UvKgAmpWpCxNko4qf5SBw4+OH4HGvm3UcP44g=";
      };
    };
}
