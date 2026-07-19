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
      # ═══════════════════════════════════════════════════════════════════════
      # `nix run .#<app>` — the ONLY entry point for every workflow (2pk.4).
      #
      # These apps are thin, IMPURE bash wrappers: they run against the
      # working-tree per-unit node_modules / generated sources (biome, eslint,
      # knip, syncpack, depcruise, panda, playwright, rsbuild come from a unit's
      # node_modules/.bin — laid down by `nix develop`'s shellHook), exactly as
      # the retired devenv tasks did. They are meant to be run FROM THE REPO ROOT
      # (the ambient `nix develop` shell). Nix-provided tools (buf, protoc
      # plugins, jdk/maven, podman, dockerfmt, hadolint, git…) come from each
      # app's runtimeInputs so the apps also work from a bare `nix run` with no
      # devshell active.
      #
      # devenv-task → app name map (see nix/README.md for the full table):
      #   buf:generate→generate  ts:check→ts-check  ci:biome→ci-biome
      #   ci:eslint→ci-eslint  ci:hygiene→ci-hygiene  ci:e2e→ci-e2e  (: → -)
      # ═══════════════════════════════════════════════════════════════════════

      # Repo-wide lint toolchain bin dir (biome/eslint/knip/syncpack/depcruise).
      toolingBin = ''export PATH="$PWD/tooling/node_modules/.bin:$PATH"'';

      # ── Shared bash fragments (the "lib") ──────────────────────────────────

      # Point Docker/Testcontainers clients at the RUNNING podman machine socket
      # (was devenv enterShell / nix devshell shellHook). Left untouched when
      # podman is down. Needed by every container-using app (playwright, e2e,
      # java-verify's Testcontainers *IT) since `nix run` may execute outside the
      # devshell that would otherwise export it.
      dockerHostWiring = ''
        if command -v podman >/dev/null 2>&1; then
          _podman_sock=$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null | head -1)
          if [ -n "$_podman_sock" ] && [ -S "$_podman_sock" ]; then
            export DOCKER_HOST="unix://$_podman_sock"
          fi
          unset _podman_sock
        fi
      '';

      # Ephemeral free-port picker (backend + web + postgres in ci-e2e).
      pickFreePort = ''
        pick_free_port() {
          node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})'
        }
      '';

      # Build+start the shared new-headless Chromium CDP container on :9222,
      # IDEMPOTENTLY (reuse when the running container matches the current image
      # AND still carries the secure-origin flag; else force-recreate). Ported
      # verbatim from the devenv playwright:up task. Used by the playwright-up app
      # AND inlined at the head of ci-e2e (mirrors devenv's `after = [playwright:up]`).
      playwrightUpBody = ''
        IMAGE=web-ui-pw-browser:local
        echo "Building $IMAGE (new-headless Chromium + socat for SW e2e)..."
        podman build -t "$IMAGE" tooling/docker/playwright-browser

        TARGET_IMAGE_ID=$(docker inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)

        # Reuse the shared container ONLY if it is running from the CURRENT image
        # build AND still carries the secure-origin flag in its Cmd; else recreate.
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
        # Readiness poll: first run pulls the image through gvproxy (~1 min) and
        # Chrome needs a moment to open the CDP port — don't return until it answers.
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

      # Shared toolchains for the codegen/backend apps.
      genInputs = [
        pkgs.bun
        pkgs.nodejs_22
        pkgs.buf
        pkgs.protobuf
        pkgs.protoc-gen-grpc-java
        repoTools.protoc-gen-jsonschema
      ];
      javaInputs = [
        pkgs.jdk25
        repoTools.maven
        pkgs.bun
        pkgs.nodejs_22
        pkgs.buf
        pkgs.protobuf
        pkgs.protoc-gen-grpc-java
        repoTools.protoc-gen-jsonschema
        pkgs.postgresql_17
      ];
      containerInputs = [
        pkgs.podman
        pkgs.podman-compose
        pkgs.docker-client
        pkgs.curl
      ];

      # writeShellApplication helper carrying our common preamble knobs.
      mkApp =
        {
          name,
          runtimeInputs ? [ ],
          text,
          excludeShellChecks ? [ ],
          meta ? { },
        }:
        {
          type = "app";
          program = lib.getExe (pkgs.writeShellApplication {
            inherit name runtimeInputs excludeShellChecks text;
          });
          inherit meta;
        };

      # ── Codegen ────────────────────────────────────────────────────────────
      generate = mkApp {
        name = "generate";
        runtimeInputs = genInputs;
        text = ''
          ${toolingBin}
          # buf resolves the node `local:` plugins (protoc-gen-es / connect-query)
          # from packages/rpc/node_modules/.bin, exactly as the dev loop does.
          export PATH="$PWD/packages/rpc/node_modules/.bin:$PATH"
          echo "==> buf generate"
          buf generate
          echo "==> wrap-jsonschema"
          bun run packages/rpc/scripts/wrap-jsonschema.ts
          # Panda's styled-system/ is derived source the web-ui-ssr TS imports.
          echo "==> panda codegen (web-ui-ssr styled-system)"
          ( cd services/web-ui-ssr && ./node_modules/.bin/panda codegen --clean )
        '';
        meta.description = "buf generate + wrap-jsonschema + panda codegen (was devenv buf:generate)";
      };

      # ── TypeScript ─────────────────────────────────────────────────────────
      ts-check = mkApp {
        name = "ts-check";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];
        text = ''
          cd services/web-ui-ssr
          exec bun run typecheck
        '';
        meta.description = "tsc typecheck (app + service worker) — was devenv ts:check";
      };

      # ── buf format / lint ──────────────────────────────────────────────────
      buf-format = mkApp {
        name = "buf-format";
        runtimeInputs = [ pkgs.buf ];
        text = "exec buf format -w";
        meta.description = "Format protobuf with buf — was devenv buf:format";
      };
      buf-format-check = mkApp {
        name = "buf-format-check";
        runtimeInputs = [ pkgs.buf ];
        text = "exec buf format --exit-code";
        meta.description = "Check protobuf formatting — was devenv buf:format:check";
      };
      buf-lint = mkApp {
        name = "buf-lint";
        runtimeInputs = [ pkgs.buf ];
        text = "exec buf lint";
        meta.description = "Lint protobuf with buf — was devenv buf:lint";
      };

      # ── Biome ──────────────────────────────────────────────────────────────
      biome-check = mkApp {
        name = "biome-check";
        text = "exec tooling/node_modules/.bin/biome check .";
        meta.description = "Biome format+lint+import checks — was devenv biome:check";
      };
      biome-fix = mkApp {
        name = "biome-fix";
        text = "exec tooling/node_modules/.bin/biome check --write .";
        meta.description = "Biome auto-fix — was devenv biome:fix";
      };
      biome-format = mkApp {
        name = "biome-format";
        text = "exec tooling/node_modules/.bin/biome format --write .";
        meta.description = "Biome format — was devenv biome:format";
      };
      biome-lint = mkApp {
        name = "biome-lint";
        text = "exec tooling/node_modules/.bin/biome lint .";
        meta.description = "Biome lint — was devenv biome:lint";
      };

      # ── ESLint ─────────────────────────────────────────────────────────────
      eslint-check = mkApp {
        name = "eslint-check";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];
        text = ''
          ${toolingBin}
          if [ -n "''${1:-}" ]; then
            exec eslint "$1"
          else
            echo "Usage: nix run .#eslint-check -- <path>" >&2
            exit 1
          fi
        '';
        meta.description = "ESLint on a path — was devenv eslint:check";
      };
      eslint-fix = mkApp {
        name = "eslint-fix";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];
        text = ''
          ${toolingBin}
          if [ -n "''${1:-}" ]; then
            exec eslint "$1" --fix
          else
            echo "Usage: nix run .#eslint-fix -- <path>" >&2
            exit 1
          fi
        '';
        meta.description = "ESLint auto-fix on a path — was devenv eslint:fix";
      };
      eslint-check-all = mkApp {
        name = "eslint-check-all";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];
        text = ''
          ${toolingBin}
          exec eslint services/web-ui-ssr/src
        '';
        meta.description = "ESLint across web-ui-ssr src — was devenv eslint:check:all";
      };

      # ── Dockerfile format / lint ───────────────────────────────────────────
      docker-fmt = mkApp {
        name = "docker-fmt";
        runtimeInputs = [ pkgs.dockerfmt ];
        text = ''
          if [ -n "''${1:-}" ]; then
            exec dockerfmt --write --newline "$1"
          else
            exec find . -name 'Dockerfile*' -not -path '*/node_modules/*' -exec dockerfmt --write --newline {} +
          fi
        '';
        meta.description = "Format Dockerfiles (dockerfmt) — was devenv docker:fmt";
      };
      docker-fmt-check = mkApp {
        name = "docker-fmt-check";
        runtimeInputs = [ pkgs.dockerfmt ];
        text = ''exec find . -name 'Dockerfile*' -not -path '*/node_modules/*' -exec dockerfmt --check --newline {} +'';
        meta.description = "Check Dockerfile formatting — was devenv docker:fmt:check";
      };
      docker-lint = mkApp {
        name = "docker-lint";
        runtimeInputs = [ pkgs.hadolint ];
        text = ''
          if [ -n "''${1:-}" ]; then
            exec hadolint --config tooling/docker/hadolint.yaml "$1"
          else
            exec find . -name 'Dockerfile*' -not -path '*/node_modules/*' -exec hadolint --config tooling/docker/hadolint.yaml {} +
          fi
        '';
        meta.description = "Lint Dockerfiles (hadolint) — was devenv docker:lint";
      };

      # ── docker-compose lint ────────────────────────────────────────────────
      compose-lint = mkApp {
        name = "compose-lint";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];
        text = ''exec bunx dclint . --recursive --config tooling/docker/dclintrc.yaml --exclude node_modules'';
        meta.description = "Lint docker-compose files (dclint) — was devenv compose:lint";
      };
      compose-lint-fix = mkApp {
        name = "compose-lint-fix";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];
        text = ''exec bunx dclint . --recursive --fix --config tooling/docker/dclintrc.yaml --exclude node_modules'';
        meta.description = "Auto-fix docker-compose lint — was devenv compose:lint:fix";
      };

      # ── Java: adapter install bridge / build / verify ──────────────────────
      # De-reactored (517): no root reactor pom. build-bom pom + adapter jar are
      # installed into ~/.m2 (the dev bridge); the service then resolves them.
      java-adapter-install = mkApp {
        name = "java-adapter-install";
        runtimeInputs = javaInputs;
        text = ''
          mvn -q -B -N install -f packages/java/build-bom/pom.xml
          mvn -q -B -f packages/java/connect-unary-adapter/pom.xml -DskipTests install
        '';
        meta.description = "Install build-bom + connect-unary-adapter into ~/.m2 — was devenv java:adapter:install";
      };
      java-build = mkApp {
        name = "java-build";
        runtimeInputs = javaInputs;
        text = ''
          mvn -q -B -N install -f packages/java/build-bom/pom.xml
          mvn -q -B -f packages/java/connect-unary-adapter/pom.xml -DskipTests install
          exec mvn -q -B -f services/business-logic-java/pom.xml -DskipTests package
        '';
        meta.description = "build-bom + adapter → ~/.m2, then package the service jar — was devenv java:build";
      };
      java-verify = mkApp {
        name = "java-verify";
        runtimeInputs = javaInputs ++ containerInputs;
        text = ''
          # Testcontainers *IT need the podman machine (DOCKER_HOST); wire it as
          # the retired devenv enterShell did.
          ${dockerHostWiring}
          mvn -q -B -N install -f packages/java/build-bom/pom.xml
          mvn -B -f packages/java/connect-unary-adapter/pom.xml clean verify
          mvn -q -B -f packages/java/connect-unary-adapter/pom.xml -DskipTests install
          exec mvn -B -f services/business-logic-java/pom.xml clean verify
        '';
        meta.description = "Verify both Java units standalone in order (adapter then service) — was devenv java:verify";
      };

      # ── Playwright CDP browser container ───────────────────────────────────
      playwright-up = mkApp {
        name = "playwright-up";
        runtimeInputs = containerInputs;
        excludeShellChecks = [ "SC2016" ];
        text = ''
          ${dockerHostWiring}
          ${playwrightUpBody}
        '';
        meta.description = "Build+start (idempotent) new-headless Chromium CDP container on :9222 — was devenv playwright:up";
      };
      playwright-down = mkApp {
        name = "playwright-down";
        runtimeInputs = containerInputs;
        text = ''
          ${dockerHostWiring}
          docker rm -f playwright-browser 2>/dev/null && echo "Playwright container stopped" || echo "No Playwright container running"
        '';
        meta.description = "Stop the Playwright Chromium container — was devenv playwright:down";
      };

      # ── CI linters ─────────────────────────────────────────────────────────
      ci-biome = mkApp {
        name = "ci-biome";
        text = "exec tooling/node_modules/.bin/biome check . --config-path tooling/biome/ci.json";
        meta.description = "Biome type-aware rules (CI) — was devenv ci:biome";
      };
      ci-eslint = mkApp {
        name = "ci-eslint";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];
        text = "exec tooling/node_modules/.bin/eslint --config tooling/eslint/ci.ts";
        meta.description = "ESLint type-checked rules (CI) — was devenv ci:eslint";
      };
      ci-lint = mkApp {
        name = "ci-lint";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];
        text = ''
          ${toolingBin}
          echo "==> Biome (base + types domain)"
          biome check . --config-path tooling/biome/ci.json
          echo "==> ESLint (precommit + type-checked)"
          eslint --config tooling/eslint/ci.ts
        '';
        meta.description = "All CI linters (Biome types + ESLint type-checked) — was devenv ci:lint";
      };
      ci-hygiene = mkApp {
        name = "ci-hygiene";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];
        text = ''
          ${toolingBin}
          echo "==> syncpack (dependency-version consistency)"
          syncpack lint
          echo "==> knip (unused files / exports / dependencies — per unit)"
          ( cd tooling && knip )
          ( cd packages/rpc && knip )
          ( cd services/web-ui-ssr && knip )
          echo "==> dependency-cruiser (module boundaries / import direction)"
          depcruise services packages --config .dependency-cruiser.cjs
        '';
        meta.description = "syncpack + per-unit knip + dependency-cruiser — was devenv ci:hygiene";
      };

      # ── Self-contained E2E (ports the devenv ci:e2e task VERBATIM) ─────────
      ci-e2e = mkApp {
        name = "ci-e2e";
        runtimeInputs =
          javaInputs
          ++ containerInputs
          ++ [
            pkgs.lsof
            pkgs.coreutils
          ];
        excludeShellChecks = [
          "SC2016"
          "SC2086"
          # cleanup/kill_port are invoked via `trap`, which shellcheck can't see.
          "SC2329"
        ];
        text = ''
          # ── Ensure the CDP browser is up (was devenv `after = [playwright:up]`) ──
          ${dockerHostWiring}
          ${playwrightUpBody}

          # ── Pick free ephemeral ports (backend + web) ─────────────────────
          ${pickFreePort}
          BACKEND_PORT=$(pick_free_port)
          WEB_PORT=$(pick_free_port)
          echo "==> Backend port: $BACKEND_PORT | web port: $WEB_PORT"

          # ── Wide-event log capture (cross-service trace_id correlation) ────
          # Both servers emit one wide-event JSON line per request; redirect each
          # to its own file so the wide-events spec can assert an inbound trace_id
          # flows through the SSR event into the backend event. MUST live outside
          # services/web-ui-ssr/test-results (Playwright wipes its outputDir at
          # suite start). A per-run temp dir survives; the trap removes it on exit.
          LOG_DIR="$(mktemp -d /tmp/wide-events-e2e.XXXXXX)"
          SSR_LOG="$LOG_DIR/ssr-server.log"
          BACKEND_LOG="$LOG_DIR/backend-server.log"
          : > "$SSR_LOG"
          : > "$BACKEND_LOG"
          echo "==> Wide-event logs: SSR=$SSR_LOG | backend=$BACKEND_LOG"

          # ── Ephemeral Postgres (podman) on a free host port ───────────────
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
            kill_port "$WEB_PORT"
            kill_port "$BACKEND_PORT"
            # -v also removes the anonymous volume the postgres image declares.
            podman rm -f -v "$PG_NAME" >/dev/null 2>&1 || true
            if [ -n "''${LOG_DIR:-}" ]; then rm -rf "$LOG_DIR"; fi
          }
          trap cleanup EXIT

          # ── Boot the ephemeral Postgres and wait for readiness ────────────
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
          # De-reactored (517): build the Java units standalone in dependency
          # order — install build-bom + the adapter jar into ~/.m2, then package.
          echo "==> Generating protobuf sources (buf) and building the Java units (build-bom + connect-unary-adapter + business-logic-java)"
          ( export PATH="$PWD/packages/rpc/node_modules/.bin:$PATH"; buf generate && bun run packages/rpc/scripts/wrap-jsonschema.ts )
          mvn -q -B -N install -f packages/java/build-bom/pom.xml
          mvn -q -B -f packages/java/connect-unary-adapter/pom.xml -DskipTests install
          mvn -q -B -f services/business-logic-java/pom.xml -DskipTests package

          echo "==> Starting business-logic-java backend on :$BACKEND_PORT (ephemeral Postgres, Flyway migrates on boot)"
          PORT=$BACKEND_PORT \
            DATABASE_URL="jdbc:postgresql://localhost:$PG_PORT/todos" \
            DATABASE_USERNAME=todos DATABASE_PASSWORD=todos \
            java -jar services/business-logic-java/target/business-logic-java.jar > "$BACKEND_LOG" 2>&1 &
          BACKEND_PID=$!

          echo "==> Waiting for backend ListTodos to answer"
          BACKEND_READY=0
          for _ in $(seq 1 30); do
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

          # Thread the dynamic ports to the test runner + fixtures.
          export E2E_BASE_URL="http://host.docker.internal:$WEB_PORT"
          export E2E_RAW_BASE_URL="http://localhost:$WEB_PORT"
          export E2E_BACKEND_URL="http://localhost:$BACKEND_PORT"
          export E2E_SSR_LOG="$SSR_LOG"
          export E2E_BACKEND_LOG="$BACKEND_LOG"

          echo "==> Running Playwright E2E suite (CDP @ http://localhost:9222)"
          set +e
          bunx playwright test
          PW_EXIT=$?
          set -e

          echo "==> Playwright report (HTML):  $PWD/playwright-report/index.html"
          echo "==> Playwright report (JUnit): $PWD/test-results/junit.xml"
          exit "$PW_EXIT"
        '';
        meta.description = "Self-contained E2E: ephemeral Postgres + backend + web server + Playwright over CDP, full teardown — was devenv ci:e2e";
      };

      # ── INFORMATIONAL proto wire-contract check (never blocks) ─────────────
      ci-proto-breaking = mkApp {
        name = "ci-proto-breaking";
        runtimeInputs = [
          pkgs.buf
          pkgs.git
        ];
        text = ''
          # Prefer the controlling terminal (findings are informational and this
          # always exits 0, so a plain stdout write could be swallowed by a caller).
          if { : > /dev/tty; } 2>/dev/null; then TTY=/dev/tty; else TTY=/dev/stdout; fi
          say() { echo "$@" > "$TTY"; }

          say "==> Checking wire contract for breaking changes vs main (informational)"
          set +e
          OUTPUT=$(buf breaking --against ".git#branch=main" 2>&1)
          EXIT=$?
          set -e
          if [ "$EXIT" -eq 0 ]; then
            say "OK Wire contract — no breaking changes vs main."
            exit 0
          fi
          if [ "$EXIT" -ne 100 ]; then
            say ""
            say "buf could not run the comparison (exit $EXIT) — check that a local"
            say "main ref exists (buf compares against '.git#branch=main')."
            say ""
            say "$OUTPUT"
            say ""
            say "(informational only — pipeline NOT failed)"
            exit 0
          fi
          say ""
          say "================================================================"
          say " WIRE CONTRACT BREAKING CHANGES vs main"
          say " Allowed in this experiment — but make sure this is DELIBERATE."
          say "================================================================"
          say ""
          say "$OUTPUT"
          say ""
          say "(informational only — pipeline NOT failed; buf exit was $EXIT)"
          exit 0
        '';
        meta.description = "INFORMATIONAL: show (never block on) proto wire-contract breaking changes vs main — was devenv ci:proto-breaking";
      };

      # ── Local stack via Arion Option A (nix-built compose) ─────────────────
      up = mkApp {
        name = "up";
        runtimeInputs = [
          pkgs.podman
          pkgs.podman-compose
        ];
        text = ''
          ${dockerHostWiring}
          exec podman compose -f ${config.packages.arion-compose} up "$@"
        '';
        meta.description = "Bring the local stack up via the nix-built Arion compose (podman)";
      };
    in
    {
      apps = {
        inherit
          generate
          ts-check
          buf-format
          buf-format-check
          buf-lint
          biome-check
          biome-fix
          biome-format
          biome-lint
          eslint-check
          eslint-fix
          eslint-check-all
          docker-fmt
          docker-fmt-check
          docker-lint
          compose-lint
          compose-lint-fix
          java-adapter-install
          java-build
          java-verify
          playwright-up
          playwright-down
          ci-biome
          ci-eslint
          ci-lint
          ci-hygiene
          ci-e2e
          ci-proto-breaking
          up
          ;
      };
    };
}
