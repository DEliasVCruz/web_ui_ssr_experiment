{
  perSystem =
    {
      pkgs,
      lib,
      config,
      repoTools,
      ...
    }:
    let
      # `nix run .#generate` — buf generate + wrap-jsonschema (= devenv's buf:generate
      # task / `bun run generate`). IMPURE: runs against the working-tree node_modules
      # (buf resolves the node-based protoc-gen-es / connect-query plugins from
      # node_modules/.bin, exactly as `bun run generate` does). Run from the repo root.
      generate = pkgs.writeShellApplication {
        name = "generate";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
          pkgs.buf
          pkgs.protobuf
          pkgs.protoc-gen-grpc-java
          repoTools.protoc-gen-jsonschema
        ];
        text = ''exec bun run generate "$@"'';
      };

      # `nix run .#up` — Arion "Option A" (2pk.3): bring the local stack up
      # against the NIX-BUILT compose file (nix/arion.nix), not the hand-written
      # docker-compose.yml (which stays for devenv during the transition). Requires
      # a started podman machine (docs/podman.md) AND the service images loaded
      # into podman (image-web-ui-ssr / image-business-logic-java / image-pw-browser
      # via nix2container copyToPodman) — those images are x86_64-linux, so on the
      # aarch64-darwin host this fully comes up only once they are built/loaded on
      # a Linux-capable builder (postgres pulls + runs regardless). 2pk.4 wires the
      # copyToPodman/copyToRegistry push into CI.
      up = pkgs.writeShellApplication {
        name = "up";
        runtimeInputs = [
          pkgs.podman
          pkgs.podman-compose
        ];
        text = ''exec podman compose -f ${config.packages.arion-compose} up "$@"'';
      };

      # `nix run .#e2e` — the self-contained Playwright suite. IMPURE by nature
      # (ephemeral podman Postgres + Java backend + CDP browser container). Rather
      # than fork the ~150-line orchestration, this thin shim delegates to the
      # authoritative devenv ci:e2e task while devenv still owns CI (until cutover,
      # 2pk.4); it runs against the ambient devenv on PATH.
      e2e = pkgs.writeShellScriptBin "e2e" ''
        exec devenv tasks run ci:e2e "$@"
      '';
    in
    {
      apps = {
        generate = {
          type = "app";
          program = lib.getExe generate;
          meta.description = "buf generate + wrap-jsonschema (mirrors devenv buf:generate)";
        };
        up = {
          type = "app";
          program = lib.getExe up;
          meta.description = "Bring the local stack up via podman compose (transition placeholder for Arion)";
        };
        e2e = {
          type = "app";
          program = lib.getExe e2e;
          meta.description = "Self-contained Playwright E2E (delegates to devenv ci:e2e during transition)";
        };
      };
    };
}
