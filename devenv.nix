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

  # Developer tasks
  tasks = {
    "biome:check" = {
      exec = "bunx biome check .";
      description = "Run Biome formatter, linter and import sorting checks";
    };
    "biome:fix" = {
      exec = "bunx biome check --write .";
      description = "Auto-fix Biome formatter, linter and import sorting issues";
    };
    "biome:format" = {
      exec = "bunx biome format --write .";
      description = "Format code with Biome";
    };
    "biome:lint" = {
      exec = "bunx biome lint .";
      description = "Lint code with Biome";
    };
    "ts:check" = {
      exec = "bun run --filter '*' typecheck";
      description = "Run TypeScript type checking across all workspaces";
    };
    "buf:generate" = {
      # `bun run generate` = `buf generate && bun run scripts/wrap-jsonschema.ts`;
      # bun puts node_modules/.bin on PATH so buf resolves the node-based TS
      # plugins, and the wrapper turns the proto-derived JSON Schema into the
      # typed `as const` modules the frontend form validator is built from.
      exec = "bun run generate";
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
    "eslint:check" = {
      exec = ''
        if [ -n "$1" ]; then
          bun run --filter "$1" lint:eslint
        else
          echo "Usage: devenv tasks run eslint:check -- <package-name>"
          exit 1
        fi
      '';
      description = "Run ESLint on a specific workspace (pass package name as argument)";
    };
    "eslint:fix" = {
      exec = ''
        if [ -n "$1" ]; then
          bun run --filter "$1" lint:eslint -- --fix
        else
          echo "Usage: devenv tasks run eslint:fix -- <package-name>"
          exit 1
        fi
      '';
      description = "Run ESLint with auto-fix on a specific workspace (pass package name as argument)";
    };
    "eslint:check:all" = {
      exec = "bun run --filter '*' lint:eslint";
      description = "Run ESLint across all workspaces";
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
        # Run headless Chromium container with CDP endpoint
        if docker ps --format '{{.Names}}' | grep -q '^playwright-browser$'; then
          echo "Playwright browser already running on http://localhost:9222"
        else
          docker rm -f playwright-browser 2>/dev/null || true
          echo "Starting headless Chromium container..."
          docker run -d --name playwright-browser --shm-size=2g -p 9222:9222 \
            chromedp/headless-shell:latest
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
      description = "Start headless Chromium container (podman) with CDP on port 9222";
    };
    "playwright:down" = {
      exec = ''
        docker rm -f playwright-browser 2>/dev/null && echo "Playwright container stopped" || echo "No Playwright container running"
      '';
      description = "Stop the Playwright Chromium container";
    };
    # ─── CI-only tasks (type-aware, slower) ──────────────────────────
    "ci:biome" = {
      exec = "bunx biome check . --config-path tooling/biome/ci.json";
      description = "Run Biome with type-aware rules (CI only)";
    };
    "ci:eslint" = {
      exec = "bunx eslint --config tooling/eslint/ci.ts";
      description = "Run ESLint with typescript-eslint type-checked rules (CI only)";
    };
    "ci:lint" = {
      exec = ''
        echo "==> Biome (base + types domain)"
        bunx biome check . --config-path tooling/biome/ci.json
        echo "==> ESLint (precommit + type-checked)"
        bunx eslint --config tooling/eslint/ci.ts
      '';
      description = "Run all CI linters (Biome types + ESLint type-checked)";
    };
    # Workspace hygiene gate: dependency-version consistency (syncpack, the single
    # authoritative version enforcer), orthogonal monorepo lints (sherif, lint-only —
    # its version rules are disabled so it never fights syncpack), unused
    # files/exports/dependencies (knip), and module-boundary / import-direction
    # rules (dependency-cruiser). All are also exposed as root package.json scripts
    # (lint:deps / lint:workspaces / lint:knip / lint:boundaries). Config &
    # rationale: .syncpackrc.json, knip.jsonc, .dependency-cruiser.cjs,
    # docs/workspace-hygiene.md, docs/architecture-boundaries.md.
    "ci:hygiene" = {
      exec = ''
        echo "==> syncpack (dependency-version consistency + workspace: pinning)"
        bunx syncpack lint
        echo "==> sherif (monorepo lints, version rules delegated to syncpack)"
        bunx sherif -r multiple-dependency-versions -r unsync-similar-dependencies -r packages-without-package-json --fail-on-warnings
        echo "==> knip (unused files / exports / dependencies)"
        bunx knip
        echo "==> dependency-cruiser (module boundaries / import direction)"
        bunx depcruise services packages --config .dependency-cruiser.cjs
      '';
      description = "Workspace hygiene: syncpack + sherif + knip + dependency-cruiser (dependency, dead-code & boundary lints)";
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
        # spec reads an empty path). A per-run temp dir is wipe-proof and leak-free.
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
        bun run generate
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

  # Use prek as the git hooks engine (Rust rewrite, devenv 2.0 native)
  git-hooks.package = pkgs.prek;

  # Pre-commit hooks
  git-hooks.hooks = {
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
      types_or = [ "javascript" "jsx" "ts" "tsx" "json" ];
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
      types_or = [ "ts" "tsx" ];
    };
    # ast-grep structural rules (sgconfig.yml + rules/). A commit that touches any
    # TS/TSX/Java file runs a FULL repo scan (pass_filenames = false) — the scan is
    # milliseconds, and a whole-repo pass means a violation can't slip in via a file
    # that wasn't itself staged. Standalone CI invocation is the same `ast-grep scan`.
    ast-grep = {
      enable = true;
      name = "ast-grep";
      entry = "ast-grep scan";
      pass_filenames = false;
      types_or = [ "ts" "tsx" "java" ];
    };
  };
}
