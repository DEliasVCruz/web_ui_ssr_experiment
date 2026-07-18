{
  perSystem =
    { pkgs, ... }:
    let
      # ── From-source tool derivations (mirrored verbatim from devenv.nix) ──
      # Built from source so codegen/formatting is fully offline and reproducible,
      # never a buf remote plugin. Exposed to other modules via _module.args.repoTools
      # (codegen.nix needs protoc-gen-jsonschema).
      dockerfmt = pkgs.buildGoModule rec {
        pname = "dockerfmt";
        version = "0.5.2";
        src = pkgs.fetchFromGitHub {
          owner = "reteps";
          repo = "dockerfmt";
          rev = "v${version}";
          hash = "sha256-WfwrFe3E+CzfZ0ITSjMD8h4yrG+mnC6y0L+7OSYjMsw=";
        };
        vendorHash = "sha256-r8vmbZ4oyplqIU6R/6hhcyjoR3E/mOFrB69TrfPYxRI=";
      };

      # bufbuild's protoc-gen-jsonschema (from protoschema-plugins), pinned to
      # v0.5.0 for the same toolchain reasons documented in devenv.nix.
      protoc-gen-jsonschema = pkgs.buildGoModule rec {
        pname = "protoc-gen-jsonschema";
        version = "0.5.0";
        src = pkgs.fetchFromGitHub {
          owner = "bufbuild";
          repo = "protoschema-plugins";
          rev = "v${version}";
          hash = "sha256-LEp7RfPfdfRmZ+Jr7HSrFe9KkfM3CEVt98xPQALwdnM=";
        };
        vendorHash = "sha256-PcVn6Lsd6yNkqA2mt0dAgd2ez+/RMLFViI6zlyMGB4o=";
        subPackages = [ "cmd/protoc-gen-jsonschema" ];
        env.GOTOOLCHAIN = "local";
      };

      # Bind Maven to jdk25 (devenv.nix's languages.java.jdk.package = jdk25 +
      # maven.enable). Plain nixpkgs maven would otherwise run on its own default JDK.
      maven = pkgs.maven.override { jdk_headless = pkgs.jdk25; };
    in
    {
      _module.args.repoTools = {
        inherit dockerfmt protoc-gen-jsonschema maven;
      };

      # ── Git hooks: lefthook (2pk.2) ───────────────────────────────────────
      # The prek / git-hooks.nix wiring that used to live here is gone. The hook
      # set is now defined in nix/lefthook.nix and rendered to the committed
      # ./lefthook.yml; the shellHook below runs `lefthook install` so this shell
      # and the devenv shell install byte-identical .git/hooks. lefthook + every
      # hook tool are on this shell's PATH (packages list below).

      devShells.default = pkgs.mkShell {
        # Parity with devenv.nix's `packages` list + languages.java (jdk25 + maven).
        packages = [
          pkgs.bun
          pkgs.nodejs_22
          pkgs.buf
          pkgs.git
          pkgs.hadolint
          pkgs.docker-client
          pkgs.podman
          pkgs.podman-compose
          pkgs.postgresql_17
          pkgs.protobuf
          pkgs.protoc-gen-grpc-java
          pkgs.ast-grep
          pkgs.jdk25
          maven
          dockerfmt
          protoc-gen-jsonschema
          # lefthook: the git-hooks runner (2pk.2, replaces prek). Reads ./lefthook.yml.
          pkgs.lefthook
        ];

        # Shared, non-secret env (mirror devenv.nix's `env`). JAVA_HOME is set here
        # explicitly since a plain mkShell does not derive it like languages.java does.
        NODE_ENV = "development";
        TESTCONTAINERS_RYUK_DISABLED = "true";
        TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = "/var/run/docker.sock";
        JAVA_HOME = "${pkgs.jdk25}";

        shellHook = ''
          # ─── Point Docker/Testcontainers clients at the podman machine (wdt.2) ──
          # Mirrors devenv.nix's enterShell: derive DOCKER_HOST from the RUNNING
          # podman machine's socket; leave it untouched when podman is down.
          if command -v podman >/dev/null 2>&1; then
            _podman_sock=$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null | head -1)
            if [ -n "$_podman_sock" ] && [ -S "$_podman_sock" ]; then
              export DOCKER_HOST="unix://$_podman_sock"
            fi
            unset _podman_sock
          fi

          # ─── Install the lefthook git hooks (same set devenv installs) ─────────
          # Reads the committed ./lefthook.yml (rendered from nix/lefthook.nix), so
          # this shell and the devenv shell install byte-identical .git/hooks.
          # --force: git-hooks.nix/prek left `core.hooksPath` set to the shared
          # worktree hooks dir; --force installs into exactly that dir (non-
          # destructive) instead of erroring on the pre-existing hooks path.
          if [ -f lefthook.yml ]; then
            lefthook install --force >/dev/null || echo "lefthook install failed (hooks not updated)" >&2
          fi

          # ─── Load .env (mirror devenv.nix's dotenv.enable = true) ──────────────
          if [ -f .env ]; then set -a; . ./.env; set +a; fi

          # ─── bun install parity (mirror devenv.nix's enterShell) ───────────────
          if [ -f package.json ]; then
            lock_hash=""
            if [ -f bun.lock ]; then
              lock_hash=$(md5 -q bun.lock 2>/dev/null || md5sum bun.lock | cut -d' ' -f1)
            fi
            cache_file="node_modules/.devenv-lock-hash"
            if [ ! -d node_modules ] || [ ! -f "$cache_file" ] || [ "$lock_hash" != "$(cat "$cache_file" 2>/dev/null)" ]; then
              echo "Lock file changed, running bun install..."
              bun install
              echo "$lock_hash" > "$cache_file"
            fi
          fi
        '';
      };
    };
}
