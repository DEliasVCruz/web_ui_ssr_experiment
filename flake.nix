{
  description = "web-ui-ssr-experiment — flake-parts skeleton for the nix migration (2pk)";

  # Transition state (2pk): devenv.nix remains AUTHORITATIVE for daily dev and CI
  # until the cutover task (2pk.4). This flake is additive — it proves the native
  # flake-parts devshell + package derivations while devenv keeps working. See
  # nix/README.md.
  inputs = {
    # Pinned to the SAME nixpkgs devenv resolves (cachix/devenv-nixpkgs/rolling)
    # so package versions — protoc 34.x, jdk25, go 1.25.x — match devenv's shell
    # and the from-source plugin hashes (dockerfmt, protoc-gen-jsonschema) carried
    # over from devenv.nix stay valid.
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    flake-parts.url = "github:hercules-ci/flake-parts";
    # Same git-hooks.nix the devenv git-hooks integration wraps, pinned to the rev
    # in devenv.lock. Its flake-parts module reproduces the prek hook install that
    # devenv performs today (NOT lefthook — that is 2pk.2).
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
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
