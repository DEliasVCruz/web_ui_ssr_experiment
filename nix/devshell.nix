{
  perSystem =
    { pkgs, config, ... }:
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

      # ── prek git hooks (mirror devenv.nix's git-hooks.hooks) ──────────────
      # git-hooks.nix's flake-parts module reproduces exactly what devenv wires
      # today: the prek runner + these eight hooks. Installed into .git/hooks via
      # config.pre-commit.installationScript in the shellHook below. Migrating the
      # hook set to lefthook is a SEPARATE task (2pk.2) — untouched here.
      pre-commit.settings = {
        package = pkgs.prek;
        hooks = {
          buf-format = {
            enable = true;
            name = "buf format";
            entry = "buf format -w";
            files = "\\.proto$";
            pass_filenames = true;
          };
          buf-lint = {
            enable = true;
            name = "buf lint";
            entry = "buf lint";
            files = "\\.proto$";
            pass_filenames = false;
          };
          biome = {
            enable = true;
            name = "biome check";
            entry = "bunx biome check --write --staged --no-errors-on-unmatched --colors=off";
            pass_filenames = false;
            types_or = [
              "javascript"
              "jsx"
              "ts"
              "tsx"
              "json"
            ];
          };
          dockerfmt = {
            enable = true;
            name = "dockerfmt";
            entry = "${dockerfmt}/bin/dockerfmt --write --newline";
            files = "(^|/)Dockerfile";
            pass_filenames = true;
          };
          hadolint = {
            enable = true;
            name = "hadolint";
            entry = "hadolint --config tooling/docker/hadolint.yaml";
            types = [ "dockerfile" ];
          };
          dclint = {
            enable = true;
            name = "dclint";
            entry = "bunx dclint --config tooling/docker/dclintrc.yaml";
            files = "(^|/)(docker-)?compose[^/]*\\.ya?ml$";
            pass_filenames = true;
          };
          eslint = {
            enable = true;
            name = "eslint";
            entry = "bunx eslint --no-warn-ignored --cache --cache-location node_modules/.cache/eslint";
            pass_filenames = true;
            types_or = [
              "ts"
              "tsx"
            ];
          };
          ast-grep = {
            enable = true;
            name = "ast-grep";
            entry = "ast-grep scan";
            pass_filenames = false;
            types_or = [
              "ts"
              "tsx"
              "java"
            ];
          };
        };
      };

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
          # prek: the git-hooks runner (git-hooks.package = pkgs.prek in devenv).
          pkgs.prek
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

          # ─── Install the prek git hooks (same set devenv installs) ─────────────
          ${config.pre-commit.installationScript}

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
