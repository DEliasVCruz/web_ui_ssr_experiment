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
    # git-hooks.nix pinned to the EXACT rev in devenv.lock (580633fa), so the prek
    # runner + hooks reproduce devenv's install verbatim (NOT lefthook — that is 2pk.2).
    git-hooks = {
      url = "github:cachix/git-hooks.nix/580633fa3fe5fc0379905986543fd7495481913d";
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
        inputs.git-hooks.flakeModule
        ./nix/devshell.nix
        ./nix/codegen.nix
        ./nix/packages-ts.nix
        ./nix/packages-java.nix
        ./nix/checks.nix
        ./nix/apps.nix
      ];
    };
}
