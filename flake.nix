{
  description = "web-ui-ssr-experiment — the single root flake (nix is the only entry point)";

  # Nix is the sole entry point (2pk.4 cutover): `nix develop` for the shell and
  # `nix run .#<app>` for every workflow. devenv is fully retired — this flake and
  # its devshell are AUTHORITATIVE for daily dev and CI. See nix/README.md.
  inputs = {
    # Plain nixos-unstable (2pk.4). Replaces the former cachix/devenv-nixpkgs pin,
    # whose `applyPatches` wrapper was an IFD that blocked cross-system eval from
    # darwin (x86_64-linux image derivations could not even evaluate). A plain
    # nixpkgs channel has no such patch derivation, so `nix flake check
    # --all-systems` now evaluates the Linux images from the darwin host.
    #
    # This rev provides every tool the workflows need at a workable version — jdk25
    # + maven-on-jdk25, bun 1.3.13, buf 1.71 + protoc plugins, lefthook 2.1.5
    # (2.x, which the last stable channel lacks), postgresql_17, podman, ast-grep,
    # hadolint, dockerfmt 0.5.4 (now packaged — no from-source build), shellcheck,
    # nixfmt. protobuf is 35.1, so `protoc --java_out` stamps gencode 4.35.1, which
    # exactly meets business-logic's protobuf-java 4.35.1 runtime pin (gencode ≤
    # runtime holds). The lock pins the exact rev the channel branch resolves to.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
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
        # De-workspaced (5ae): each TS unit's nix module lives in its own directory
        # (self-contained). rpc's module folds in the former nix/codegen.nix
        # (rpc-gen) + its node_modules + the importable @web-ui-poc/rpc package;
        # web-ui-ssr's folds in the former nix/packages-ts.nix build; tooling owns
        # the repo-wide lint toolchain node_modules.
        ./packages/rpc/nix
        ./services/web-ui-ssr/nix
        ./tooling/nix
        # De-reactored (517): each Java unit's nix module lives in its own directory
        # (self-contained), mirroring the TS units. build-bom is a pom-only unit with
        # no derivation; the adapter builds packages.connect-unary-adapter, which the
        # service module injects into its offline .m2 as a pre-built jar.
        ./packages/java/connect-unary-adapter/nix
        ./services/business-logic-java/nix
        ./nix/images.nix
        ./nix/arion.nix
        ./nix/checks.nix
        ./nix/apps.nix
      ];
    };
}
