{
  description = "web-ui-ssr-experiment — flake-parts skeleton for the nix migration (2pk)";

  # Transition state (2pk): devenv.nix remains AUTHORITATIVE for daily dev and CI
  # until the cutover task (2pk.4). This flake is additive — it proves the native
  # flake-parts devshell + package derivations while devenv keeps working. See
  # nix/README.md.
  inputs = {
    # Pinned to the EXACT nixpkgs rev devenv.lock resolves (cachix/devenv-nixpkgs
    # rolling → efff4732), not the moving `rolling` branch, so this flake's tool
    # versions match devenv's byte-for-byte: bun 1.3.11, protoc 34.0 (rpc-gen /java
    # stamps gencode 4.34.0 identically), jdk25, go 1.25.2 — which also keeps the
    # from-source plugin hashes (dockerfmt, protoc-gen-jsonschema) copied from
    # devenv.nix valid and keeps pom.xml's gencode invariant honest.
    nixpkgs.url = "github:cachix/devenv-nixpkgs/efff47329167854ce48541c7ef731bf120753c7e";
    flake-parts.url = "github:hercules-ci/flake-parts";
    # git-hooks.nix input removed in 2pk.2: the git hooks now run under lefthook
    # (nix/lefthook.nix), whose config is committed as ./lefthook.yml and whose
    # tools come from the devshell PATH. lefthook itself is `pkgs.lefthook`, so no
    # extra flake input is needed. No other module referenced git-hooks.nix.
    # OCI images (2pk.3): nix2container is the design note's primary image builder
    # (gap 4 — archive-less, skip-already-pushed layers, copyToPodman/copyToRegistry).
    nix2container = {
      url = "github:nlewo/nix2container";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Arion "Option A" (2pk.3): a nix-built compose file the runtime consumes.
    arion = {
      url = "github:hercules-ci/arion";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      # aarch64-darwin = the dev host; x86_64-linux = the Fly.io deploy target
      # (Daniel's ruling 2026-07-18). Linux image builds via builders are a LATER
      # task — this skeleton only declares the system so evaluation is complete.
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
      ];

      imports = [
        ./nix/devshell.nix
        ./nix/lefthook.nix
        ./nix/codegen.nix
        ./nix/packages-ts.nix
        ./nix/packages-java.nix
        ./nix/images.nix
        ./nix/arion.nix
        ./nix/checks.nix
        ./nix/apps.nix
      ];
    };
}
