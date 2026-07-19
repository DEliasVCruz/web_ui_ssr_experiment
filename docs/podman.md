# Local container runtime: podman

The local container runtime for this repo is [podman](https://podman.io/) driving
a lightweight Linux VM (Fedora CoreOS) via Apple's virtualization framework. It is
used for three things:

1. Running `docker-compose.yml` locally (`podman compose`).
2. Backing [Testcontainers](https://testcontainers.com/) integration tests
   (the Java service, wired via env — see below).
3. The headless Chromium E2E browser container (`nix run .#playwright-up`,
   used by `nix run .#ci-e2e`).

podman is installed **alongside** any existing Docker Desktop install — it does
not replace it. The `docker` CLI and Docker Desktop are left untouched; inside
the `nix develop` shell the `docker` client is simply pointed at the podman socket (see
[DOCKER_HOST](#env-vars-and-where-they-live)). colima, which previously ran the
E2E browser container, was **removed** in the podman migration — podman is
the only project-managed runtime now.

> Decided 2026-07-16. `nerdctl` was considered and deferred to the nix epic.

## Fresh-machine setup (macOS, Apple Silicon)

Everything is provisioned by the repo's `nix develop` shell plus two one-time podman
machine commands. From the repo root:

```bash
# 1. Enter the nix develop shell — this puts `podman` and `podman-compose` on PATH
#    (both come from nixpkgs; the podman wrapper bundles the macOS VM helpers
#    vfkit + gvproxy, so nothing extra needs installing).
nix develop

# 2. Create the podman machine (one-time; pulls the CoreOS VM image, ~minutes).
podman machine init

# 3. Start it (and on every reboot).
podman machine start
```

That's it. `podman machine init` accepts defaults (applehv VM type, rootless,
5 CPU / 2 GiB RAM / 100 GiB sparse disk on this host). The OCI runtime inside the
VM is **crun** on **cgroup v2** — nothing to configure.

Verify:

```bash
podman machine list          # STATUS "Currently running"
podman info                  # Host.OCIRuntime.Name == crun, Rootless == true
podman run --rm alpine echo hi
```

## Env vars and where they live

All wiring lives in the flake dev shell (`nix/devshell.nix`), so every
`nix develop` gets it automatically:

| Variable | Value | Set in |
| --- | --- | --- |
| `DOCKER_HOST` | `unix://<podman machine socket>` | `enterShell` (derived at shell entry from `podman machine inspect`) |
| `TESTCONTAINERS_RYUK_DISABLED` | `true` | `env` block |
| `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` | `/var/run/docker.sock` | `env` block |

`DOCKER_HOST` is **derived, not hardcoded**: `enterShell` runs
`podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'` and
exports `unix://<that path>` — but only if the socket actually exists. If the
podman machine is not running (or not created), `DOCKER_HOST` is left untouched
so `docker` keeps talking to whatever context is otherwise active. Outside the
`nix develop` shell, `DOCKER_HOST` is never set by this repo, so Docker Desktop is
unaffected.

Testcontainers reads these three variables to find and use podman. That is the
entire integration — there is **no** `~/.testcontainers.properties` file on the
machine (deliberate; see below).

## Ryuk (the Testcontainers reaper)

**Decision: Ryuk is DISABLED** (`TESTCONTAINERS_RYUK_DISABLED=true`).

Ryuk is the sidecar Testcontainers normally starts to reap leftover containers
after the JVM exits. Its autodetection is unreliable on macOS **rootless** podman.
We disable it because:

- It keeps the podman machine **rootless** — podman's secure default — with **no
  machine-level reconfiguration**, matching the conservative-changes guardrail.
- Under normal exits Testcontainers stops its own containers via JVM shutdown
  hooks / try-with-resources, so Ryuk is only needed to catch **hard crashes**.

**Tradeoff:** after a hard-crashed (`kill -9`, power loss) test run, containers
may be left behind. Clean them up with:

```bash
podman container prune
```

**Alternative (not chosen), if you want automatic reaping:**

```bash
podman machine stop
podman machine set --rootful      # reconfigures the machine to run rootful
podman machine start
```

and create `~/.testcontainers.properties` containing:

```properties
ryuk.container.privileged=true
```

then remove `TESTCONTAINERS_RYUK_DISABLED` from `nix/devshell.nix`. Rootful + privileged
Ryuk lets the reaper run. We avoided this because rootful is a heavier, harder-to-
reverse change to the developer's machine.

> **Revisited in wdt.5** (which added the `*IT` Testcontainers integration suite).
> **Decision: keep Ryuk disabled + rootless + 2 GiB RAM**, with `podman container
> prune` as the documented cleanup habit after a hard-killed run. Rationale: the
> Maven JVMs run on the **host**, not in the VM — the VM only hosts containers, so
> its memory ceiling governs container footprint alone. `nix run .#java-verify` runs at most
> **one** `postgres:17-alpine` at a time (the jOOQ-codegen throwaway at
> generate-sources, then surefire's singleton container, then — in a separate
> forked JVM — the failsafe suite's singleton; never concurrent), and the failsafe
> `*IT` reuses that same singleton container via `PostgresSupport` rather than
> starting its own. Measured on the 2 GiB machine: **~1.28 GiB free at idle even
> with the E2E Chromium container up**, and a full `nix run .#java-verify` + `nix run .#ci-e2e` run
> (postgres + chromium, the heaviest concurrent set) stayed comfortably within it.
> Every container is closed by a JVM shutdown hook on clean exit, so a normal run
> leaks nothing; `--memory 4096` and rootful+privileged-Ryuk remain available (as
> above) if the container set ever grows.

## Running docker-compose under podman

From the repo root, inside the `nix develop` shell:

```bash
podman compose -f docker-compose.yml up --build -d   # builds both Dockerfiles via buildah
# ... services on 127.0.0.1:3000 (web-ui-ssr) and 127.0.0.1:3001 (business-logic)
podman compose -f docker-compose.yml down
```

`podman compose` shells out to an **external compose provider**. It looks for a
`docker-compose` binary on `PATH` **and** in Docker's CLI-plugin locations
(`~/.docker/cli-plugins/docker-compose` etc.), preferring those over
`podman-compose`. On any machine with Docker Desktop installed, that means
Docker's `docker-compose` is effectively always the provider and the
`podman-compose` fallback (kept in the nix dev shell for Docker-free machines) is
unreachable. Either provider is just a client — it talks to the podman socket
via `DOCKER_HOST` and does **not** touch the Docker Desktop daemon.

The image builds run under **buildah** and honour the Dockerfiles' BuildKit
`TARGETARCH` arg. `docker-compose.yml` has no healthchecks and only plain
`depends_on`, so it maps cleanly with no compose-provider edits.

## Known rough edges

- **Connection refused while the machine claims to be running.** If podman
  commands fail with `connection refused` (or the socket vanishes) while
  `podman machine list` says the machine is running — e.g. after a gvproxy
  crash or a host sleep/wake — restart the machine:
  `podman machine stop && podman machine start`.
- **`podman compose` provider selection.** See above — on Docker Desktop
  machines the provider is Docker's own `docker-compose`. If you see a
  `>>>> Executing external compose provider "…docker-compose" <<<<` banner,
  that is expected.
- **E2E browser (`nix run .#playwright-up`) needs the machine up.** The app runs the
  Chromium container through `docker` → podman socket, so `podman machine start`
  must have happened first. The app polls `localhost:9222/json/version` before
  returning, so the first-run image pull (~1 min through gvproxy) doesn't race
  the test suite.
- **Ryuk disabled** ⇒ hard-crashed runs can leak containers (see above).
- **Rootless port binding.** The machine is rootless, so containers can only bind
  host ports ≥ 1024. `docker-compose.yml` uses 3000/3001, so this is fine; switch
  to `--rootful` if you ever need privileged ports.

## Uninstalling / reversal

To remove everything this migration put on a machine:

```bash
# 1. Delete the podman machine (VM + its disk under
#    ~/.local/share/containers/podman/machine and ~/.config/containers/…)
podman machine stop
podman machine rm podman-machine-default

# 2. Remove the packages: delete pkgs.podman / pkgs.podman-compose from
#    nix/devshell.nix (and the DOCKER_HOST/TESTCONTAINERS_* wiring); the nix store
#    paths are garbage-collected by `nix store gc` eventually.
```

No files outside those directories are created; there is no
`~/.testcontainers.properties` and nothing is installed via brew.
