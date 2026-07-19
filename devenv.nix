{ pkgs, ... }:

let
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

  # bufbuild's own protoc-gen-jsonschema (from protoschema-plugins). Invoked by
  # buf (buf.gen.yaml) to emit JSON Schema from the proto — including buf.validate
  # constraints (min_len/max_len -> minLength/maxLength) — which the frontend form
  # validator is derived from. Built from source so generation is fully offline
  # and reproducible (same idiom as dockerfmt above), never a buf remote plugin.
  protoc-gen-jsonschema = pkgs.buildGoModule rec {
    pname = "protoc-gen-jsonschema";
    # Pinned to v0.5.0 (not the newer v0.6.0): v0.6.0's go.mod requires
    # `go 1.25.6`, one patch ahead of this nixpkgs' go 1.25.2, and no 1.25.6
    # toolchain is available to build hermetically offline. v0.5.0 requires only
    # `go 1.23.0` and still ships protobuf v1.36.6 + protovalidate, so it fully
    # supports editions-2023 and the buf.validate string min_len/max_len rules
    # this repo uses.
    version = "0.5.0";
    src = pkgs.fetchFromGitHub {
      owner = "bufbuild";
      repo = "protoschema-plugins";
      rev = "v${version}";
      hash = "sha256-LEp7RfPfdfRmZ+Jr7HSrFe9KkfM3CEVt98xPQALwdnM=";
    };
    vendorHash = "sha256-PcVn6Lsd6yNkqA2mt0dAgd2ez+/RMLFViI6zlyMGB4o=";
    subPackages = [ "cmd/protoc-gen-jsonschema" ];
    # Force a local toolchain so a sandboxed build never tries to fetch one.
    env.GOTOOLCHAIN = "local";
  };
in
{
  # Load .env file automatically
  dotenv.enable = true;

  # Java toolchain (services/business-logic-java)
  languages.java = {
    enable = true;
    jdk.package = pkgs.jdk25;
    maven.enable = true;
  };

  # System packages
  packages = [
    pkgs.bun
    pkgs.nodejs_22
    pkgs.buf
    pkgs.git
    pkgs.hadolint
    # docker-client is the plain docker CLI (no daemon); inside the devenv
    # shell it talks to the podman machine via DOCKER_HOST (see enterShell).
    pkgs.docker-client
    # Local container runtime (task wdt.2): podman drives a lightweight
    # Fedora CoreOS VM via Apple's virtualization framework (applehv + vfkit,
    # both bundled by the nixpkgs podman wrapper on darwin). colima was removed
    # in the same migration — everything container-shaped (compose, e2e browser,
    # testcontainers) now runs on the podman machine. `podman-compose` is a
    # fallback compose provider for `podman compose`.
    pkgs.podman
    pkgs.podman-compose
    # PostgreSQL server + client binaries (initdb/pg_ctl/createdb), used by the
    # hermetic jOOQ codegen (task 2pk.6, services/business-logic-java/scripts/
    # jooq-codegen.sh): an ephemeral throwaway Postgres started on a loopback
    # port + unix socket in a temp dir, migrated with Flyway and introspected by
    # jOOQ — NO container runtime / Docker socket needed for codegen. Pinned to
    # 17 to match the integration tests' postgres:17 catalog. Integration TESTS
    # still use Testcontainers/podman (deliberate, out of scope for 2pk.6).
    pkgs.postgresql_17
    dockerfmt
    # protoc + grpc-java plugin, invoked by buf (buf.gen.yaml) to emit the
    # Java protobuf/gRPC sources for services/business-logic-java
    pkgs.protobuf
    pkgs.protoc-gen-grpc-java
    # JSON Schema codegen for the frontend form validator (see derivation above).
    protoc-gen-jsonschema
    # ast-grep: cross-language (TS + Java) structural pattern engine. Encodes the
    # machine-checkable AGENTS.md working agreements that the other guardrails do
    # NOT cover — ArchUnit owns Java layering, Panda strictTokens owns styling
    # values, the strict tsconfig owns type discipline. Config: sgconfig.yml +
    # rules/. Wired as the `ast-grep` git hook below; run standalone (CI) with
    # `ast-grep scan`.
    pkgs.ast-grep

    # lefthook: the git-hooks runner (2pk.2, replaces prek). Reads ./lefthook.yml
    # (rendered from nix/lefthook.nix); installed into .git/hooks in enterShell.
    pkgs.lefthook
  ];

  # Shared, non-secret env vars
  env = {
    NODE_ENV = "development";

    # ─── Testcontainers → podman wiring (task wdt.2) ────────────────────
    # Testcontainers supports podman but it is not in their CI matrix, so a
    # few knobs are required. DOCKER_HOST is set dynamically in enterShell
    # (it depends on the running podman machine's socket path); the two
    # values below are static.
    #
    # Ryuk (the testcontainers reaper) autodetection is unreliable on macOS
    # rootless podman, so it is DISABLED here. Rationale: this keeps the
    # podman machine rootless (podman's secure default) and avoids any
    # machine-level reconfiguration. Tradeoff: containers from a HARD-crashed
    # test run are not auto-reaped — clean them with `podman container prune`.
    # ALTERNATIVE (not chosen, documented in docs/podman.md): a rootful
    # machine (`podman machine set --rootful`) plus a ~/.testcontainers.properties
    # containing `ryuk.container.privileged=true`, which lets ryuk run.
    TESTCONTAINERS_RYUK_DISABLED = "true";
    # Inside the podman VM the daemon socket lives at the classic docker path;
    # testcontainers uses this when it mounts the socket into helper containers.
    TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = "/var/run/docker.sock";
  };

  # Only runs bun install when lockfile changes
  enterShell = ''
    # ─── Point Docker/Testcontainers clients at the podman machine (wdt.2) ──
    # DOCKER_HOST is derived from the RUNNING podman machine's socket rather
    # than hardcoded, so it is correct regardless of machine name/provider and
    # never breaks a checkout on another host. If no podman machine socket is
    # available (podman not started, or machine absent), DOCKER_HOST is left
    # untouched so `docker` keeps talking to whatever context is otherwise
    # active — this shell does not force podman on when it is down.
    if command -v podman >/dev/null 2>&1; then
      _podman_sock=$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null | head -1)
      if [ -n "$_podman_sock" ] && [ -S "$_podman_sock" ]; then
        export DOCKER_HOST="unix://$_podman_sock"
      fi
      unset _podman_sock
    fi

    # De-workspaced (5ae): there is NO root package.json / bun workspace. Each TS
    # unit is self-contained with its own package.json + committed bun.lock, so we
    # install per-unit (only when that unit's lockfile changed). web-ui-ssr's
    # postinstall symlinks node_modules/@web-ui-poc/rpc → packages/rpc for the dev
    # loop; install rpc first so that target exists.
    for _unit in packages/rpc tooling services/web-ui-ssr; do
      if [ -f "$_unit/package.json" ]; then
        _lock_hash=""
        if [ -f "$_unit/bun.lock" ]; then
          _lock_hash=$(md5 -q "$_unit/bun.lock" 2>/dev/null || md5sum "$_unit/bun.lock" | cut -d' ' -f1)
        fi
        _cache_file="$_unit/node_modules/.devenv-lock-hash"
        if [ ! -d "$_unit/node_modules" ] || [ ! -f "$_cache_file" ] || [ "$_lock_hash" != "$(cat "$_cache_file" 2>/dev/null)" ]; then
          echo "Lock file changed, running bun install in $_unit..."
          ( cd "$_unit" && bun install )
          echo "$_lock_hash" > "$_cache_file"
        fi
      fi
    done
    unset _unit _lock_hash _cache_file

    # ─── Install the lefthook git hooks (2pk.2) ───────────────────────────
    # Reads the committed ./lefthook.yml (rendered from nix/lefthook.nix), so this
    # shell and the nix devshell install byte-identical .git/hooks. --force installs
    # into the shared worktree hooks dir that git-hooks.nix/prek left pinned via
    # core.hooksPath (non-destructive) rather than erroring on it.
    if [ -f lefthook.yml ] && command -v lefthook >/dev/null 2>&1; then
      lefthook install --force >/dev/null || echo "lefthook install failed (hooks not updated)" >&2
    fi
  '';

  # Developer tasks
  tasks = {
    # De-workspaced (5ae): the repo-wide lint toolchain lives in the `tooling` unit,
    # so its binaries are invoked from tooling/node_modules/.bin (no root node_modules).
    "biome:check" = {
      exec = "tooling/node_modules/.bin/biome check .";
      description = "Run Biome formatter, linter and import sorting checks";
    };
    "biome:fix" = {
      exec = "tooling/node_modules/.bin/biome check --write .";
      description = "Auto-fix Biome formatter, linter and import sorting issues";
    };
    "biome:format" = {
      exec = "tooling/node_modules/.bin/biome format --write .";
      description = "Format code with Biome";
    };
    "biome:lint" = {
      exec = "tooling/node_modules/.bin/biome lint .";
      description = "Lint code with Biome";
    };
    "ts:check" = {
      # Only web-ui-ssr has hand-written TS (packages/rpc is buf-generated). Its
      # typecheck script also chains the service-worker tsconfig.
      exec = "cd services/web-ui-ssr && bun run typecheck";
      description = "Run TypeScript type checking (web-ui-ssr: app + service worker)";
    };
    "buf:generate" = {
      # buf generate + wrap-jsonschema (de-workspaced 5ae). packages/rpc owns the
      # buf codegen plugins (protoc-gen-es / connect-query); buf resolves them by
      # name from packages/rpc/node_modules/.bin. The wrapper turns the proto-derived
      # JSON Schema into the typed `as const` modules the frontend validator uses.
      exec = ''
        export PATH="$PWD/packages/rpc/node_modules/.bin:$PATH"
        buf generate && bun run packages/rpc/scripts/wrap-jsonschema.ts
      '';
      description = "Generate TypeScript + JSON Schema code from protobuf definitions";
    };
    "buf:format" = {
      exec = "buf format -w";
      description = "Format protobuf files with buf";
    };
    "buf:format:check" = {
      exec = "buf format --exit-code";
      description = "Check protobuf formatting without modifying files";
    };
    "buf:lint" = {
      exec = "buf lint";
      description = "Lint protobuf files with buf";
    };
    "docker:fmt" = {
      exec = ''
        if [ -n "$1" ]; then
          dockerfmt --write --newline "$1"
        else
          find . -name 'Dockerfile*' -not -path '*/node_modules/*' -exec dockerfmt --write --newline {} +
        fi
      '';
      description = "Format Dockerfiles with dockerfmt (pass a path to format a specific file)";
    };
    "docker:fmt:check" = {
      exec = ''find . -name 'Dockerfile*' -not -path '*/node_modules/*' -exec dockerfmt --check --newline {} +'';
      description = "Check Dockerfile formatting without modifying files";
    };
    "docker:lint" = {
      exec = ''
        if [ -n "$1" ]; then
          hadolint --config tooling/docker/hadolint.yaml "$1"
        else
          find . -name 'Dockerfile*' -not -path '*/node_modules/*' -exec hadolint --config tooling/docker/hadolint.yaml {} +
        fi
      '';
      description = "Lint Dockerfiles with hadolint (pass a path to lint a specific file)";
    };
    # De-workspaced (5ae): eslint + its plugins live in the `tooling` unit. The base
    # config is the repo-root eslint.config.ts (auto-discovered). Pass a path to scope.
    "eslint:check" = {
      exec = ''
        export PATH="$PWD/tooling/node_modules/.bin:$PATH"
        if [ -n "$1" ]; then
          eslint "$1"
        else
          echo "Usage: devenv tasks run eslint:check -- <path>"
          exit 1
        fi
      '';
      description = "Run ESLint on a specific path (pass a path as argument)";
    };
    "eslint:fix" = {
      exec = ''
        export PATH="$PWD/tooling/node_modules/.bin:$PATH"
        if [ -n "$1" ]; then
          eslint "$1" --fix
        else
          echo "Usage: devenv tasks run eslint:fix -- <path>"
          exit 1
        fi
      '';
      description = "Run ESLint with auto-fix on a specific path (pass a path as argument)";
    };
    "eslint:check:all" = {
      exec = ''
        export PATH="$PWD/tooling/node_modules/.bin:$PATH"
        eslint services/web-ui-ssr/src
      '';
      description = "Run ESLint across the hand-written TS source (web-ui-ssr)";
    };
    "compose:lint" = {
      exec = ''bunx dclint . --recursive --config tooling/docker/dclintrc.yaml --exclude .devenv node_modules'';
      description = "Lint docker-compose files with dclint";
    };
    "compose:lint:fix" = {
      exec = ''bunx dclint . --recursive --fix --config tooling/docker/dclintrc.yaml --exclude .devenv node_modules'';
      description = "Auto-fix docker-compose lint issues";
    };
    "playwright:up" = {
      # Runs on podman: the devenv shell's DOCKER_HOST points the docker CLI at
      # the podman machine socket (see enterShell), so this requires
      # `podman machine start` to have been run (docs/podman.md).
      exec = ''
        # Run the shared NEW-HEADLESS Chromium container with a CDP endpoint.
        #
        # NEW HEADLESS (task 1w9.5): the previous image (chromedp/headless-shell) runs
        # OLD headless, which PROVABLY ignores --unsafely-treat-insecure-origin-as-secure
        # (Playwright #22944; confirmed live — flag present in argv, navigator.serviceWorker
        # still undefined). New headless HONOURS the flag (verified live: isSecureContext
        # true, "serviceWorker" in navigator true on http://host.docker.internal:<port>),
        # so e2e/sw.spec.ts genuinely EXECUTES instead of skipping. The image is built
        # locally from tooling/docker/playwright-browser (a new-headless Chromium plus a
        # socat bridge — see below and that dir's run.sh).
        #
        # Secure-context flag (task 1w9.2): the in-container browser reaches the app over
        # plain HTTP at host.docker.internal:<ephemeral port>, so Service Worker
        # registration is blocked by default (SW needs a secure context, and the
        # host.docker.internal:<port> origin is neither https nor localhost). We allowlist
        # it with --unsafely-treat-insecure-origin-as-secure. The value is a HOSTNAME
        # WILDCARD (*.docker.internal) — hostname patterns (no scheme) match the host on
        # ANY scheme and ANY port, which is required because ci:e2e picks an ephemeral web
        # port unknown at container-start (post-iq2.3). --user-data-dir is the companion
        # incantation Chromium wants for the flag to take effect. Both are forwarded into
        # the browser argv via run.sh's `$@`.
        #
        # CDP wiring (preserved): new-headless Chromium binds --remote-debugging-port to
        # 127.0.0.1 regardless of --remote-debugging-address, so run.sh runs socat to
        # bridge the published 0.0.0.0:9222 to Chromium's loopback DevTools on :9223 —
        # the CDP endpoint stays reachable from the host and test containers on :9222
        # exactly as with headless-shell (whose own run.sh did the same).
        #
        # BUILD with `podman build`, run/inspect with `docker` (DOCKER_HOST → the same
        # podman engine): the docker CLI's buildx defaults to Docker Desktop's
        # docker-container driver here, which ignores DOCKER_HOST and would build into a
        # place `docker run` can't see.
        IMAGE=web-ui-pw-browser:local
        echo "Building $IMAGE (new-headless Chromium + socat for SW e2e)..."
        podman build -t "$IMAGE" tooling/docker/playwright-browser

        TARGET_IMAGE_ID=$(docker inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)

        # Reuse the shared container ONLY if it is running from the CURRENT image build
        # AND still carries the secure-origin flag in its Cmd; otherwise force-recreate.
        # This subsumes the old stale-Cmd check (a prior run without the flag) and also
        # recreates when run.sh/the Dockerfile changed (new image id) or when the old
        # headless-shell container is still up.
        recreate=1
        if docker ps --format '{{.Names}}' | grep -q '^playwright-browser$'; then
          container_image_id=$(docker inspect playwright-browser --format '{{.Image}}' 2>/dev/null || true)
          container_cmd=$(docker inspect playwright-browser --format '{{json .Config.Cmd}}' 2>/dev/null || true)
          if [ -n "$TARGET_IMAGE_ID" ] && [ "$container_image_id" = "$TARGET_IMAGE_ID" ] \
            && printf '%s' "$container_cmd" | grep -q 'unsafely-treat-insecure-origin-as-secure'; then
            recreate=0
          fi
        fi

        if [ "$recreate" -eq 0 ]; then
          echo "Playwright browser already running (current image + secure-origin flag) on http://localhost:9222"
        else
          docker rm -f playwright-browser 2>/dev/null || true
          echo "Starting new-headless Chromium container (with insecure-origin-as-secure for SW e2e)..."
          docker run -d --name playwright-browser --shm-size=2g -p 9222:9222 \
            "$IMAGE" \
            --user-data-dir=/tmp/pw-profile \
            "--unsafely-treat-insecure-origin-as-secure=*.docker.internal"
        fi
        # Readiness poll: the first run pulls the image through gvproxy
        # (~1 min), and Chrome itself needs a moment to open the CDP port —
        # don't return (and let ci:e2e race ahead) until CDP answers.
        echo "Waiting for CDP endpoint on http://localhost:9222 ..."
        ready=0
        for _ in $(seq 1 60); do
          if curl -sf --connect-timeout 2 --max-time 4 -o /dev/null "http://localhost:9222/json/version"; then
            ready=1
            break
          fi
          sleep 2
        done
        if [ "$ready" -ne 1 ]; then
          echo "ERROR: CDP endpoint never became ready on :9222" >&2
          docker logs playwright-browser 2>&1 | tail -20 >&2 || true
          exit 1
        fi
        echo "Playwright browser running on http://localhost:9222"
      '';
      description = "Build+start new-headless Chromium container (podman) with CDP on port 9222";
    };
    "playwright:down" = {
      exec = ''
        docker rm -f playwright-browser 2>/dev/null && echo "Playwright container stopped" || echo "No Playwright container running"
      '';
      description = "Stop the Playwright Chromium container";
    };
    # ─── CI-only tasks (type-aware, slower) ──────────────────────────
    # De-workspaced (5ae): CI linters run from the `tooling` unit's node_modules/.bin.
    "ci:biome" = {
      exec = "tooling/node_modules/.bin/biome check . --config-path tooling/biome/ci.json";
      description = "Run Biome with type-aware rules (CI only)";
    };
    "ci:eslint" = {
      exec = "tooling/node_modules/.bin/eslint --config tooling/eslint/ci.ts";
      description = "Run ESLint with typescript-eslint type-checked rules (CI only)";
    };
    "ci:lint" = {
      exec = ''
        export PATH="$PWD/tooling/node_modules/.bin:$PATH"
        echo "==> Biome (base + types domain)"
        biome check . --config-path tooling/biome/ci.json
        echo "==> ESLint (precommit + type-checked)"
        eslint --config tooling/eslint/ci.ts
      '';
      description = "Run all CI linters (Biome types + ESLint type-checked)";
    };
    # Hygiene gate (de-workspaced 5ae): dependency-version consistency (syncpack, the
    # single authoritative version enforcer), unused files/exports/dependencies (knip,
    # run PER UNIT since knip needs a package.json root and there is no longer a
    # workspace root), and module-boundary / import-direction rules
    # (dependency-cruiser). sherif was dropped: it is a bun-workspace linter with no
    # non-workspace mode, and de-workspacing removed the root it analysed. Config &
    # rationale: .syncpackrc.json, {tooling,packages/rpc,services/web-ui-ssr}/knip.json,
    # .dependency-cruiser.cjs, docs/workspace-hygiene.md, docs/architecture-boundaries.md.
    "ci:hygiene" = {
      exec = ''
        export PATH="$PWD/tooling/node_modules/.bin:$PATH"
        echo "==> syncpack (dependency-version consistency)"
        syncpack lint
        echo "==> knip (unused files / exports / dependencies — per unit)"
        ( cd tooling && knip )
        ( cd packages/rpc && knip )
        ( cd services/web-ui-ssr && knip )
        echo "==> dependency-cruiser (module boundaries / import direction)"
        depcruise services packages --config .dependency-cruiser.cjs
      '';
      description = "Hygiene: syncpack + per-unit knip + dependency-cruiser (dependency, dead-code & boundary lints)";
    };
    "ci:e2e" = {
      # FULLY self-contained end-to-end Playwright run for web-ui-ssr: on a clean
      # machine with NOTHING pre-running, this task starts its OWN ephemeral
      # Postgres (podman) + business-logic backend (Flyway migrates on boot),
      # seeds it, builds + starts the web-ui-ssr prod server, runs the whole
      # suite, and tears EVERYTHING down (backend + web server + Postgres
      # container), even on failure.
      #
      # Ports: BOTH the backend and the web server bind free ephemeral ports
      # picked at task start (not fixed :3001/:3000). This removes the class of
      # bugs where a stale/foreign process on a fixed port gets silently reused
      # (the original failure mode) or where a developer's own dev server on
      # :3000/:3001 collides with — or gets killed by — this task. The ports are
      # threaded through every consumer:
      #   * backend:      PORT=$BACKEND_PORT DATABASE_URL=<ephemeral pg> java -jar …/business-logic-java.jar
      #   * client build: PUBLIC_BUSINESS_LOGIC_URL=http://host.docker.internal:$BACKEND_PORT
      #   * prod server:  BUSINESS_LOGIC_URL=http://localhost:$BACKEND_PORT PORT=$WEB_PORT
      #   * test runner:  E2E_BASE_URL / E2E_RAW_BASE_URL (web) + E2E_BACKEND_URL
      #
      # The CDP browser runs in a container and reaches the host as
      # host.docker.internal, so the client bundle and Playwright baseURL point
      # there; the prod server (Bun, binds 0.0.0.0:$WEB_PORT) is reached from the
      # container at host.docker.internal:$WEB_PORT. Auto-started deps: the CDP
      # browser container (playwright:up) via `after`.
      after = [ "playwright:up" ];
      exec = ''
        set -euo pipefail

        # ── Pick free ephemeral ports (backend + web) ─────────────────────
        # Both ports are task-owned and random, so nothing foreign can be on
        # them: local dev servers on the old fixed :3000/:3001 never collide,
        # and teardown's port-scoped kill can never hit a foreign process.
        pick_free_port() {
          node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})'
        }
        BACKEND_PORT=$(pick_free_port)
        WEB_PORT=$(pick_free_port)
        echo "==> Backend port: $BACKEND_PORT | web port: $WEB_PORT"

        # ── Wide-event log capture (cross-service trace_id correlation) ────
        # Both servers emit one wide-event JSON line per request to stdout;
        # redirect each to its own file so the wide-events e2e spec can assert
        # that an inbound trace_id flows through the SSR event into the backend
        # event. MUST live outside services/web-ui-ssr/test-results: Playwright
        # deletes its outputDir at suite start, which would unlink the live log
        # files mid-run (the servers keep writing to the orphaned inodes and the
        # spec reads an empty path). A per-run temp dir survives that wipe; the
        # cleanup trap below removes it on exit so runs don't accumulate dirs.
        LOG_DIR="$(mktemp -d /tmp/wide-events-e2e.XXXXXX)"
        SSR_LOG="$LOG_DIR/ssr-server.log"
        BACKEND_LOG="$LOG_DIR/backend-server.log"
        : > "$SSR_LOG"
        : > "$BACKEND_LOG"
        echo "==> Wide-event logs: SSR=$SSR_LOG | backend=$BACKEND_LOG"

        # ── Ephemeral Postgres (podman) on a free host port ───────────────
        # DATABASE_URL points the backend at this throwaway instance; Flyway
        # migrates it on startup. A per-run container name + --rm + a force-remove
        # in teardown keeps the task self-contained, idempotent and leak-free.
        PG_PORT=$(pick_free_port)
        PG_NAME="pg-e2e-$$-$RANDOM"
        echo "==> Ephemeral Postgres: container $PG_NAME on :$PG_PORT"

        BACKEND_PID=""
        SERVER_PID=""

        kill_port() {
          local pids
          pids=$(lsof -ti "tcp:$1" 2>/dev/null || true)
          if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi
        }

        cleanup() {
          echo "==> Teardown: stopping web server + backend, removing Postgres container"
          if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
          if [ -n "$BACKEND_PID" ]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
          # Belt-and-braces: free the ports even if the tracked PIDs were only
          # wrappers around the real listeners.
          kill_port "$WEB_PORT"
          kill_port "$BACKEND_PORT"
          # Force-remove the ephemeral Postgres (no leak even on failure).
          # -v also removes its ANONYMOUS volume: the postgres image declares
          # VOLUME /var/lib/postgresql/data, and a force-remove preempts --rm's
          # own anonymous-volume cleanup — without -v every run leaks one volume.
          podman rm -f -v "$PG_NAME" >/dev/null 2>&1 || true
          # Remove the per-run wide-event log dir (created above) — the servers
          # holding the files are dead by now, so nothing accumulates in /tmp.
          if [ -n "''${LOG_DIR:-}" ]; then rm -rf "$LOG_DIR"; fi
        }
        trap cleanup EXIT

        # ── Boot the ephemeral Postgres and wait for readiness ────────────
        # First run pulls postgres:17-alpine through gvproxy — generous budget.
        podman run -d --rm --name "$PG_NAME" \
          -e POSTGRES_DB=todos -e POSTGRES_USER=todos -e POSTGRES_PASSWORD=todos \
          -p "127.0.0.1:$PG_PORT:5432" postgres:17-alpine
        echo "==> Waiting for Postgres to accept connections"
        PG_READY=0
        for _ in $(seq 1 60); do
          if podman exec "$PG_NAME" pg_isready -U todos -d todos >/dev/null 2>&1; then
            PG_READY=1
            break
          fi
          sleep 1
        done
        if [ "$PG_READY" -ne 1 ]; then
          echo "ERROR: ephemeral Postgres never became ready on :$PG_PORT" >&2
          podman logs "$PG_NAME" 2>&1 | tail -20 >&2 || true
          exit 1
        fi

        # ── Build + start the business-logic-java backend ─────────────────
        echo "==> Generating protobuf sources (buf) and building the Java reactor (connect-unary-adapter + business-logic-java)"
        ( export PATH="$PWD/packages/rpc/node_modules/.bin:$PATH"; buf generate && bun run packages/rpc/scripts/wrap-jsonschema.ts )
        mvn -q -f pom.xml package

        echo "==> Starting business-logic-java backend on :$BACKEND_PORT (ephemeral Postgres, Flyway migrates on boot)"
        PORT=$BACKEND_PORT \
          DATABASE_URL="jdbc:postgresql://localhost:$PG_PORT/todos" \
          DATABASE_USERNAME=todos DATABASE_PASSWORD=todos \
          java -jar services/business-logic-java/target/business-logic-java.jar > "$BACKEND_LOG" 2>&1 &
        BACKEND_PID=$!

        echo "==> Waiting for backend ListTodos to answer"
        BACKEND_READY=0
        for _ in $(seq 1 30); do
          # --connect-timeout/--max-time keep the 30s retry budget real: a
          # socket that accepts but never replies must not block curl forever.
          if curl -sf --connect-timeout 3 --max-time 5 -o /dev/null -X POST "http://localhost:$BACKEND_PORT/todo.v1.TodoService/ListTodos" \
              -H 'Content-Type: application/json' -d '{}'; then
            BACKEND_READY=1
            break
          fi
          sleep 1
        done
        if [ "$BACKEND_READY" -ne 1 ]; then
          echo "ERROR: business-logic backend never became ready on :$BACKEND_PORT" >&2
          exit 1
        fi

        # ── Seed a deterministic fixture set (3 todos) ────────────────────
        echo "==> Seeding deterministic todos"
        for title in "Buy groceries" "Write the E2E suite" "Ship the release"; do
          curl -sf --connect-timeout 3 --max-time 5 -o /dev/null -X POST "http://localhost:$BACKEND_PORT/todo.v1.TodoService/CreateTodo" \
            -H 'Content-Type: application/json' -d "{\"title\":\"$title\"}"
        done

        cd services/web-ui-ssr

        echo "==> Building web-ui-ssr (client -> host.docker.internal:$BACKEND_PORT)"
        PUBLIC_BUSINESS_LOGIC_URL="http://host.docker.internal:$BACKEND_PORT" bun run build

        echo "==> Starting prod server on :$WEB_PORT"
        BUSINESS_LOGIC_URL="http://localhost:$BACKEND_PORT" PORT=$WEB_PORT bun run start > "$SSR_LOG" 2>&1 &
        SERVER_PID=$!

        echo "==> Waiting for prod server"
        SERVER_READY=0
        for _ in $(seq 1 30); do
          if curl -sf --connect-timeout 3 --max-time 5 -o /dev/null "http://localhost:$WEB_PORT/"; then
            SERVER_READY=1
            break
          fi
          sleep 1
        done
        if [ "$SERVER_READY" -ne 1 ]; then
          echo "ERROR: web-ui-ssr prod server never became ready on :$WEB_PORT" >&2
          exit 1
        fi

        # Thread the dynamic ports to the test runner + fixtures:
        #   * E2E_BASE_URL      → Playwright baseURL (in-container browser, via
        #                         host.docker.internal) — playwright.config.ts
        #   * E2E_RAW_BASE_URL  → host-side raw SSR fetches (fixtures.ts)
        #   * E2E_BACKEND_URL   → host-side raw backend RPCs (fixtures.ts)
        export E2E_BASE_URL="http://host.docker.internal:$WEB_PORT"
        export E2E_RAW_BASE_URL="http://localhost:$WEB_PORT"
        export E2E_BACKEND_URL="http://localhost:$BACKEND_PORT"
        # Wide-event log files for the cross-service correlation spec.
        export E2E_SSR_LOG="$SSR_LOG"
        export E2E_BACKEND_LOG="$BACKEND_LOG"

        echo "==> Running Playwright E2E suite (CDP @ http://localhost:9222)"
        # Capture the suite's exit code without letting `set -e` abort before we
        # print where the persisted report lives (needed because devenv swallows
        # this stdout on the happy path and we still want the artifact path on
        # failure).
        set +e
        bunx playwright test
        PW_EXIT=$?
        set -e

        echo "==> Playwright report (HTML):  $PWD/playwright-report/index.html"
        echo "==> Playwright report (JUnit): $PWD/test-results/junit.xml"
        exit "$PW_EXIT"
      '';
      description = "Self-contained E2E: ephemeral Postgres (podman) + start+seed own backend, build+run web server, Playwright over CDP, full teardown";
    };
    "ci:proto-breaking" = {
      # INFORMATIONAL wire-contract check. Compares the current proto module
      # (working tree included — uncommitted edits count) against the tip of
      # `main` using buf's FILE breaking category (see buf.yaml `breaking:`).
      #
      # Breaking changes are ALLOWED in this experiment, so this task NEVER
      # fails the pipeline: it captures buf's exit code, prints any findings
      # under a loud, unmissable banner, and always exits 0. Its only job is to
      # make contract drift impossible to miss so it stays deliberate.
      #
      # Edge case — running ON main (or when the branch has no proto delta vs
      # main): `.git#branch=main` resolves to main's tip, so the comparison is
      # against the same committed protos and buf reports no changes → quiet OK.
      exec = ''
        set -uo pipefail
        # `devenv tasks run` BUFFERS a task's stdout and stderr and only replays
        # them when the task FAILS (non-zero exit); on success both are hidden
        # (NB: `--show-output` does NOT surface them either — empirically it
        # still prints only `{}`). Since this task is informational and always
        # exits 0, its findings would otherwise be invisible on a plain run. So
        # we prefer the controlling terminal (/dev/tty) when one is actually
        # writable, and fall back to stdout otherwise — headlessly visible only
        # via the GLOBAL verbose flag: `devenv --verbose tasks run <task>`. The
        # probe actually opens /dev/tty — on macOS `[ -w /dev/tty ]` can be true
        # while writes still fail with "Device not configured". `say` centralizes
        # this so every line lands on the best available sink.
        if { : > /dev/tty; } 2>/dev/null; then TTY=/dev/tty; else TTY=/dev/stdout; fi
        say() { echo "$@" > "$TTY"; }

        say "==> Checking wire contract for breaking changes vs main (informational)"
        # `set +e` around buf: it exits non-zero (100) when it finds breaking
        # changes, which is an EXPECTED, non-fatal outcome here. devenv wraps the
        # task body with errexit, so without this the script would abort at buf.
        set +e
        OUTPUT=$(buf breaking --against ".git#branch=main" 2>&1)
        EXIT=$?
        set -e
        if [ "$EXIT" -eq 0 ]; then
          say "✓ Wire contract OK — no breaking changes vs main."
          exit 0
        fi
        # buf exits 100 when it detected breaking changes; any other non-zero
        # exit means the comparison itself failed (e.g. exit 1 with "couldn't
        # find remote ref main" when no local main ref exists). Don't dress a
        # tooling failure up as contract breakage. (Caveat: proto COMPILE errors
        # also exit 100, indistinguishable from real breakage — buf lint/format
        # hooks catch those long before this check.) Still informational: exit 0.
        if [ "$EXIT" -ne 100 ]; then
          say ""
          say "⚠ buf could not run the comparison (exit $EXIT) — check that a local"
          say "⚠ main ref exists (buf compares against '.git#branch=main')."
          say ""
          say "$OUTPUT"
          say ""
          say "(informational only — pipeline NOT failed)"
          exit 0
        fi
        say ""
        say "⚠ ================================================================== ⚠"
        say "⚠  WIRE CONTRACT BREAKING CHANGES vs main                            ⚠"
        say "⚠  Allowed in this experiment — but make sure this is DELIBERATE.    ⚠"
        say "⚠ ================================================================== ⚠"
        say ""
        say "$OUTPUT"
        say ""
        say "(informational only — pipeline NOT failed; buf exit was $EXIT)"
        exit 0
      '';
      description = "INFORMATIONAL: show (never block on) proto wire-contract breaking changes vs main";
    };
  };

  # ── Git hooks: lefthook (2pk.2, replaces prek) ────────────────────────────
  # The hook set is no longer defined here. It lives in nix/lefthook.nix, rendered
  # to the committed ./lefthook.yml, and installed into .git/hooks by the
  # `lefthook install` call in enterShell above — the SAME file and hooks the nix
  # devshell installs, so both shells converge byte-for-byte. lefthook + every hook
  # tool (buf, biome/eslint/dclint via bunx, dockerfmt, hadolint, ast-grep) are on
  # this shell's PATH via the `packages` list. See nix/lefthook.nix for the full
  # hook→prek parity table and the 8cc eslint-scoping fix.
}
