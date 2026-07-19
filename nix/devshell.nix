{
  perSystem =
    { pkgs, ... }:
    let
      # ── From-source tool derivation ───────────────────────────────────────
      # bufbuild's protoc-gen-jsonschema (from protoschema-plugins), pinned to
      # v0.5.0. Built from source because nixpkgs does not package it; invoked by
      # buf (buf.gen.yaml) to emit JSON Schema (incl. buf.validate min_len/max_len
      # → minLength/maxLength) that the frontend form validator is derived from.
      # v0.5.0 needs only `go 1.23.0` (GOTOOLCHAIN=local keeps the build offline)
      # and still ships protobuf v1.36.6 + protovalidate. Exposed to other modules
      # via _module.args.repoTools (rpc-gen + the generate app need it).
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

      # dockerfmt is now packaged by nixpkgs (0.5.4) — the former from-source
      # buildGoModule derivation is retired (2pk.4). Formats Dockerfiles (the
      # docker-fmt app + the dockerfmt git hook).
      dockerfmt = pkgs.dockerfmt;

      # Bind Maven to jdk25 (plain nixpkgs maven would run on its own default JDK).
      maven = pkgs.maven.override { jdk_headless = pkgs.jdk25; };
    in
    {
      # Shared with nix/apps.nix + packages/rpc/nix (rpc-gen).
      _module.args.repoTools = {
        inherit dockerfmt protoc-gen-jsonschema maven;
      };

      # ── The one devshell: `nix develop` (2pk.4 — devenv fully retired) ─────
      # This is the SOLE entry point for interactive dev. Its shellHook is the
      # complete bootstrap (formerly devenv's enterShell): a fresh clone that runs
      # `nix develop` is fully provisioned afterward. Git hooks are lefthook
      # (nix/lefthook.nix → committed ./lefthook.yml), installed by the shellHook.
      devShells.default = pkgs.mkShell {
        packages = [
          pkgs.bun
          pkgs.nodejs_22
          pkgs.buf
          pkgs.git
          pkgs.hadolint
          # Plain docker CLI (no daemon); talks to the podman machine via DOCKER_HOST.
          pkgs.docker-client
          # Local container runtime (podman machine on Apple virtualization) + a
          # compose fallback provider. Drives compose, the e2e browser, and
          # Testcontainers.
          pkgs.podman
          pkgs.podman-compose
          # PostgreSQL server+client (initdb/pg_ctl) for the hermetic jOOQ codegen
          # (services/business-logic-java/scripts/jooq-codegen.sh). Pinned to 17 to
          # match the integration tests' postgres:17 catalog.
          pkgs.postgresql_17
          # protoc + grpc-java plugin (buf.gen.yaml Java codegen).
          pkgs.protobuf
          pkgs.protoc-gen-grpc-java
          # ast-grep: cross-language structural guardrails (sgconfig.yml + rules/),
          # wired as the ast-grep git hook; run standalone with `ast-grep scan`.
          pkgs.ast-grep
          # nixfmt (RFC-style) — formats this repo's *.nix.
          pkgs.nixfmt
          # shellcheck — lints the shell in the nix apps (writeShellApplication runs
          # it at build time) and any ad-hoc scripting in the shell.
          pkgs.shellcheck
          pkgs.jdk25
          maven
          dockerfmt
          protoc-gen-jsonschema
          # lefthook: the git-hooks runner (reads ./lefthook.yml).
          pkgs.lefthook
        ];

        # Shared, non-secret env. JAVA_HOME is set explicitly (plain mkShell does
        # not derive it the way a language module would).
        NODE_ENV = "development";
        # Testcontainers → podman: Ryuk autodetection is unreliable on macOS
        # rootless podman, so it is DISABLED (clean crashed runs with
        # `podman container prune`; see docs/podman.md). The socket override is
        # the classic docker path inside the podman VM.
        TESTCONTAINERS_RYUK_DISABLED = "true";
        TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = "/var/run/docker.sock";
        JAVA_HOME = "${pkgs.jdk25}";

        shellHook = ''
          # ─── Point Docker/Testcontainers clients at the podman machine ─────────
          # Derive DOCKER_HOST from the RUNNING podman machine socket; leave it
          # untouched when podman is down (this shell never forces podman on).
          if command -v podman >/dev/null 2>&1; then
            _podman_sock=$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null | head -1)
            if [ -n "$_podman_sock" ] && [ -S "$_podman_sock" ]; then
              export DOCKER_HOST="unix://$_podman_sock"
            fi
            unset _podman_sock
          fi

          # ─── Load .env ─────────────────────────────────────────────────────────
          if [ -f .env ]; then set -a; . ./.env; set +a; fi

          # ─── Per-unit bun install (de-workspaced 5ae) ──────────────────────────
          # There is NO root package.json / bun workspace. Each TS unit is
          # self-contained with its own package.json + committed bun.lock, so we
          # install per-unit (only when that unit's lockfile changed). Order matters:
          # web-ui-ssr's postinstall symlinks node_modules/@web-ui-poc/rpc →
          # packages/rpc and its `prepare` runs panda codegen, so install rpc FIRST
          # (symlink target) then web-ui-ssr LAST. Scripts run (no --ignore-scripts),
          # so the symlink + panda styled-system/ are provisioned on entry.
          for _unit in packages/rpc tooling services/web-ui-ssr; do
            if [ -f "$_unit/package.json" ]; then
              _lock_hash=""
              if [ -f "$_unit/bun.lock" ]; then
                _lock_hash=$(md5 -q "$_unit/bun.lock" 2>/dev/null || md5sum "$_unit/bun.lock" | cut -d' ' -f1)
              fi
              _cache_file="$_unit/node_modules/.bun-lock-hash"
              if [ ! -d "$_unit/node_modules" ] || [ ! -f "$_cache_file" ] || [ "$_lock_hash" != "$(cat "$_cache_file" 2>/dev/null)" ]; then
                echo "Lock file changed, running bun install in $_unit..."
                ( cd "$_unit" && bun install )
                echo "$_lock_hash" > "$_cache_file"
              fi
            fi
          done
          unset _unit _lock_hash _cache_file

          # ─── Install the lefthook git hooks ────────────────────────────────────
          # Reads the committed ./lefthook.yml (rendered from nix/lefthook.nix).
          # --force installs into the shared worktree hooks dir even when a prior
          # core.hooksPath is pinned (non-destructive).
          if [ -f lefthook.yml ] && command -v lefthook >/dev/null 2>&1; then
            lefthook install --force >/dev/null || echo "lefthook install failed (hooks not updated)" >&2
          fi
        '';
      };
    };
}
