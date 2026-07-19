{
  perSystem =
    {
      pkgs,
      lib,
      config,
      repoTools,
      inputs',
      imageInfo,
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
      # plugins, jdk/maven, podman, git…) come from each app's runtimeInputs so
      # the apps also work from a bare `nix run` with no devshell active.
      #
      # devenv-task → app name map (see nix/README.md for the full table):
      #   buf:generate→generate  ts:check→ts-check  ci:biome→ci-biome
      #   ci:eslint→ci-eslint  ci:hygiene→ci-hygiene  ci:e2e→ci-e2e  (: → -)
      # ═══════════════════════════════════════════════════════════════════════

      # Repo-wide lint toolchain bin dir (biome/eslint/knip/syncpack/depcruise).
      toolingBin = ''export PATH="$PWD/tooling/node_modules/.bin:$PATH"'';

      # ── Shared bash fragments (the "lib") ──────────────────────────────────

      # Testcontainers → podman wiring (was devenv `env` + enterShell / nix devshell
      # shellHook). Point Docker/Testcontainers clients at the RUNNING podman machine
      # socket (left untouched when podman is down) AND set the two static knobs the
      # devshell exported: Ryuk autodetection is unreliable on macOS rootless podman
      # so it is DISABLED, and the socket override is the classic docker path inside
      # the podman VM. Needed by every container-using app (playwright, e2e,
      # java-verify's Testcontainers *IT) because `nix run` may execute OUTSIDE the
      # devshell that would otherwise export these.
      dockerHostWiring = ''
        export TESTCONTAINERS_RYUK_DISABLED=true
        export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
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
        IMAGE=${imageInfo.names.pw-browser}:local
        # The pw-browser container image is now the NIX2CONTAINER image (1vl) —
        # the Dockerfile was deleted. Ensure it is loaded into podman; if absent,
        # realize it through the aarch64-linux builder VM and load it (idempotent).
        if ! podman image exists "$IMAGE"; then
          echo "pw-browser nix image not in podman — realizing via the linux-builder…"
          ${builderLib}
          if ! vm_up; then
            ${builderStart}
          fi
          ${realizeLoadFn}
          realize_and_load image-pw-browser "${imageInfo.names.pw-browser}" "local"
        else
          echo "pw-browser nix image already loaded ($IMAGE)."
        fi

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
        # openssh + coreutils: the pw-browser image is realized through the
        # aarch64-linux builder VM over ssh when absent (1vl — Dockerfile deleted).
        pkgs.openssh
        pkgs.coreutils
      ];

      # ══ Local aarch64-linux image builder (1vl) ═══════════════════════════
      # Realizing Linux OCI images on this aarch64-DARWIN host needs an
      # aarch64-linux builder. We use a REPO-SCOPED nixpkgs `darwin.linux-builder`
      # QEMU VM (Hypervisor.framework accel) booted on demand — NO host mutation:
      # no /etc/nix edits, no nix-darwin `linux-builder.enable`, no sudo. The VM
      # authorizes a SELF-GENERATED key from a scratch dir and forwards guest
      # ssh(22) → host :31022. Because macOS nix is multi-user, `--builders` would
      # make the ROOT daemon ssh (key-ownership friction), so instead we drive the
      # VM entirely CLIENT-SIDE as the invoking user: export the derivation
      # closure over ssh, `nix-store --realise` on the VM, export the result back,
      # then `skopeo copy nix:… docker-archive:` + `podman load` into the machine.
      linuxSystem = "aarch64-linux";
      builderPort = "31022";

      # nix2container's skopeo (understands the `nix:` transport) built for THIS
      # (darwin) host, so it can read the copied-back Linux image closure and emit
      # a docker-archive for `podman load`.
      n2cSkopeo = inputs'.nix2container.packages.skopeo-nix2container;

      # create-builder = add-keys (which sudo-installs creds — AVOIDED) + run-builder.
      # We call run-builder DIRECTLY (it only `nix-store --add`s the keys + boots
      # qemu — no sudo). Grep its path out of create-builder so the closure (hence
      # run-builder) stays a runtime dep of the app and is never GC'd out from under us.
      #
      # DARWIN-ONLY: `darwin.linux-builder` (a macOS-host concept) has no
      # aarch64-linux build, so force it ONLY on darwin — otherwise `nix flake
      # check --all-systems` fails evaluating the aarch64-linux app set. On a
      # non-darwin host these builder apps are inert (empty path); the builder is
      # never needed there (you'd realize the Linux images natively).
      createBuilderBin = lib.optionalString pkgs.stdenv.hostPlatform.isDarwin "${pkgs.darwin.linux-builder}/bin/create-builder";

      # Common builder scratch + ssh helpers (sourced by the builder apps).
      builderLib = ''
        BUILDER_DIR="''${XDG_CACHE_HOME:-$HOME/.cache}/web-ui-ssr-linux-builder"
        BUILDER_KEY="$BUILDER_DIR/keys/builder_ed25519"
        # -F /dev/null: ignore the user's ~/.ssh/config (e.g. a colima Include with
        # options this ssh build rejects) — every needed option is passed explicitly.
        vm_ssh() { ssh -F /dev/null -i "$BUILDER_KEY" -p ${builderPort} \
          -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o ConnectTimeout=4 -o BatchMode=yes builder@localhost "$@"; }
        vm_up() { vm_ssh true >/dev/null 2>&1; }
      '';

      # Boot the VM idempotently and block until ssh answers.
      builderStart = ''
        ${builderLib}
        mkdir -p "$BUILDER_DIR/keys" "$BUILDER_DIR/tmp"
        if [ ! -f "$BUILDER_KEY" ]; then
          ssh-keygen -q -f "$BUILDER_KEY" -t ed25519 -N "" -C 'builder@localhost'
        fi
        if vm_up; then
          echo "linux-builder already running (ssh :${builderPort})."
        else
          RUNBUILDER=$(grep -o '/nix/store/[a-z0-9]*-run-builder/bin/run-builder' \
            ${createBuilderBin} | head -1)
          echo "Booting aarch64-linux builder VM (first run pulls the NixOS VM + builds a ~20GB qcow2 under $BUILDER_DIR)…"
          KEYS="$BUILDER_DIR/keys" \
          NIX_DISK_IMAGE="$BUILDER_DIR/nixos.qcow2" \
          TMPDIR="$BUILDER_DIR/tmp" USE_TMPDIR=1 \
          NIX_SSL_CERT_FILE="''${NIX_SSL_CERT_FILE:-/etc/ssl/cert.pem}" \
            nohup "$RUNBUILDER" > "$BUILDER_DIR/vm.log" 2>&1 &
          echo $! > "$BUILDER_DIR/vm.pid"
          echo "Waiting for ssh on :${builderPort} …"
          for _ in $(seq 1 90); do
            if vm_up; then break; fi
            sleep 4
          done
          if vm_up; then
            echo "linux-builder ready ($(vm_ssh 'uname -m'))."
          else
            echo "ERROR: linux-builder never became reachable; see $BUILDER_DIR/vm.log" >&2
            exit 1
          fi
        fi
      '';

      # Realize one aarch64-linux image THROUGH the VM and load it into podman.
      # Args: <package-attr> <image-name> <image-tag>
      realizeLoadFn = ''
        realize_and_load() {
          local attr="$1" iname="$2" itag="$3" drv out tar
          echo "==> $iname:$itag — evaluating (aarch64-linux)"
          drv=$(nix eval --raw ".#packages.${linuxSystem}.$attr.drvPath")
          echo "==> $iname:$itag — sending derivation closure to the builder"
          nix-store --export $(nix-store -qR "$drv") | vm_ssh "nix-store --import >/dev/null"
          echo "==> $iname:$itag — realising on the builder"
          out=$(vm_ssh "nix-store --realise '$drv'" | tail -1)
          echo "==> $iname:$itag — copying the image closure back"
          vm_ssh "nix-store --export \$(nix-store -qR '$out')" | nix-store --import >/dev/null
          tar="$(mktemp -d)/image.tar"
          echo "==> $iname:$itag — skopeo nix: → docker-archive → podman load"
          ${lib.getExe' n2cSkopeo "skopeo"} --insecure-policy copy "nix:$out" "docker-archive:$tar:$iname:$itag"
          podman load -i "$tar"
          rm -rf "$(dirname "$tar")"
        }
      '';

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
          program = lib.getExe (
            pkgs.writeShellApplication {
              inherit
                name
                runtimeInputs
                excludeShellChecks
                text
                ;
            }
          );
          inherit meta;
        };

      # ── Codegen ────────────────────────────────────────────────────────────
      generate = mkApp {
        name = "generate";
        runtimeInputs = genInputs;
        text = ''
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

      # ── Dev loop ───────────────────────────────────────────────────────────
      # web-ui-ssr dev server (tsx watch of src/index.ts). The backend it calls
      # during SSR is started separately (`nix run .#up`, or java-build + run).
      dev = mkApp {
        name = "dev";
        runtimeInputs = [
          pkgs.bun
          pkgs.nodejs_22
        ];
        text = ''
          cd services/web-ui-ssr
          exec bun run dev
        '';
        meta.description = "Run the web-ui-ssr dev server (tsx watch)";
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
        excludeShellChecks = [
          "SC2016"
          # $(nix-store -qR …) word-splitting in the builder realize/load helper.
          "SC2046"
        ];
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
          # $(nix-store -qR …) word-splitting in the builder realize/load helper.
          "SC2046"
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
          # `nix run` streams stdout directly (no devenv task buffering), so just
          # write findings to stdout — this stays visible on a plain run AND is
          # capturable with `nix run .#ci-proto-breaking > findings.log`.
          echo "==> Checking wire contract for breaking changes vs main (informational)"
          set +e
          OUTPUT=$(buf breaking --against ".git#branch=main" 2>&1)
          EXIT=$?
          set -e
          if [ "$EXIT" -eq 0 ]; then
            echo "OK Wire contract — no breaking changes vs main."
            exit 0
          fi
          if [ "$EXIT" -ne 100 ]; then
            echo ""
            echo "buf could not run the comparison (exit $EXIT) — check that a local"
            echo "main ref exists (buf compares against '.git#branch=main')."
            echo ""
            echo "$OUTPUT"
            echo ""
            echo "(informational only — pipeline NOT failed)"
            exit 0
          fi
          echo ""
          echo "================================================================"
          echo " WIRE CONTRACT BREAKING CHANGES vs main"
          echo " Allowed in this experiment — but make sure this is DELIBERATE."
          echo "================================================================"
          echo ""
          echo "$OUTPUT"
          echo ""
          echo "(informational only — pipeline NOT failed; buf exit was $EXIT)"
          exit 0
        '';
        meta.description = "INFORMATIONAL: show (never block on) proto wire-contract breaking changes vs main — was devenv ci:proto-breaking";
      };

      # ── Local aarch64-linux builder VM lifecycle (1vl) ─────────────────────
      linux-builder = mkApp {
        name = "linux-builder";
        runtimeInputs = [
          pkgs.openssh
          pkgs.coreutils
        ];
        excludeShellChecks = [ "SC2046" ];
        text = ''
          cmd="''${1:-start}"
          ${builderLib}
          case "$cmd" in
            start) ${builderStart} ;;
            status)
              if vm_up; then echo "linux-builder: running ($(vm_ssh 'uname -m'), ssh :${builderPort})"; else echo "linux-builder: stopped"; fi
              ;;
            stop)
              if [ -f "$BUILDER_DIR/vm.pid" ] && kill "$(cat "$BUILDER_DIR/vm.pid")" 2>/dev/null; then
                rm -f "$BUILDER_DIR/vm.pid"; echo "linux-builder stopped."
              else
                pkill -f 'qemu-system-aarch64.*nixos' 2>/dev/null && echo "linux-builder stopped (by match)." || echo "linux-builder not running."
              fi
              ;;
            *) echo "usage: nix run .#linux-builder -- {start|status|stop}" >&2; exit 1 ;;
          esac
        '';
        meta.description = "Manage the repo-scoped aarch64-linux builder VM (start|status|stop) — no host mutation (1vl)";
      };

      # ── Realize the aarch64-linux images through the builder → podman (1vl) ─
      build-images = mkApp {
        name = "build-images";
        runtimeInputs = [
          pkgs.openssh
          pkgs.coreutils
          pkgs.podman
        ];
        excludeShellChecks = [
          "SC2046"
          "SC2091"
        ];
        text = ''
          ${dockerHostWiring}
          ${builderLib}
          if ! vm_up; then
            echo "Builder not up — starting it first (nix run .#linux-builder start)…"
            ${builderStart}
          fi
          ${realizeLoadFn}
          realize_and_load image-business-logic-java "${imageInfo.names.business-logic-java}" "${imageInfo.tag}"
          realize_and_load image-web-ui-ssr          "${imageInfo.names.web-ui-ssr}"          "${imageInfo.tag}"
          realize_and_load image-pw-browser          "${imageInfo.names.pw-browser}"          "local"
          echo "==> Loaded images:"
          podman images --format '{{.Repository}}:{{.Tag}}' | grep -E 'web-ui-ssr-experiment|web-ui-pw-browser' || true
        '';
        meta.description = "Realize the 3 aarch64-linux OCI images through the builder VM and load them into podman (1vl)";
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
          # The nix service images must be loaded into podman first
          # (`nix run .#build-images`); postgres pulls upstream. Warn if missing.
          if ! podman image exists "${imageInfo.names.business-logic-java}:${imageInfo.tag}" 2>/dev/null; then
            echo "NOTE: nix images not loaded — run 'nix run .#build-images' first (postgres still pulls)." >&2
          fi
          exec podman compose -f ${config.packages.arion-compose} up "$@"
        '';
        meta.description = "Bring the local stack up via the nix-built Arion compose (podman); images from .#build-images";
      };
      down = mkApp {
        name = "down";
        runtimeInputs = [
          pkgs.podman
          pkgs.podman-compose
        ];
        text = ''
          ${dockerHostWiring}
          exec podman compose -f ${config.packages.arion-compose} down "$@"
        '';
        meta.description = "Tear down the local Arion stack (podman compose down)";
      };
    in
    {
      apps = {
        inherit
          generate
          dev
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
          linux-builder
          build-images
          up
          down
          ;
      };
    };
}
