# Local container runtime: podman

The local container runtime for this repo is [podman](https://podman.io/) driving
a lightweight Linux VM (Fedora CoreOS) via Apple's virtualization framework. It is
used for two things:

1. Running `docker-compose.yml` locally (`podman compose`).
2. Backing [Testcontainers](https://testcontainers.com/) integration tests
   (the Java service, wired via env — see below).

podman is installed **alongside** any existing Docker Desktop / colima install —
it does not replace them. The `docker` CLI, Docker Desktop, and colima are all
left untouched; inside the devenv shell the `docker` client is simply pointed at
the podman socket (see [DOCKER_HOST](#env-vars-and-where-they-live)).

> Decided 2026-07-16. `nerdctl` was considered and deferred to the nix epic.

## Fresh-machine setup (macOS, Apple Silicon)

Everything is provisioned by the repo's `devenv` shell plus two one-time podman
machine commands. From the repo root:

```bash
# 1. Enter the devenv shell — this puts `podman` and `podman-compose` on PATH
#    (both come from nixpkgs; the podman wrapper bundles the macOS VM helpers
#    vfkit + gvproxy, so nothing extra needs installing).
devenv shell

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

All wiring lives in `devenv.nix`, so every `devenv shell` gets it automatically:

| Variable | Value | Set in |
| --- | --- | --- |
| `DOCKER_HOST` | `unix://<podman machine socket>` | `enterShell` (derived at shell entry from `podman machine inspect`) |
| `TESTCONTAINERS_RYUK_DISABLED` | `true` | `env` block |
| `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` | `/var/run/docker.sock` | `env` block |

`DOCKER_HOST` is **derived, not hardcoded**: `enterShell` runs
`podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'` and
exports `unix://<that path>` — but only if the socket actually exists. If the
podman machine is not running (or not created), `DOCKER_HOST` is left untouched
so `docker` keeps talking to whatever context is otherwise active (e.g. colima).
Outside the devenv shell, `DOCKER_HOST` is never set by this repo, so Docker
Desktop / colima are unaffected.

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

then remove `TESTCONTAINERS_RYUK_DISABLED` from `devenv.nix`. Rootful + privileged
Ryuk lets the reaper run. We avoided this because rootful is a heavier, harder-to-
reverse change to the developer's machine.

## Running docker-compose under podman

From the repo root, inside the devenv shell:

```bash
podman compose -f docker-compose.yml up --build -d   # builds both Dockerfiles via buildah
# ... services on 127.0.0.1:3000 (web-ui-ssr) and 127.0.0.1:3001 (business-logic)
podman compose -f docker-compose.yml down
```

`podman compose` shells out to an **external compose provider**. It prefers a
`docker-compose` binary on `PATH` if one exists (that provider is just a client —
it talks to the podman socket via `DOCKER_HOST`, it does **not** touch the Docker
Desktop daemon), and otherwise falls back to `podman-compose` (provided by devenv
from nixpkgs, so a machine with no Docker install still works).

The image builds run under **buildah** and honour the Dockerfiles' BuildKit
`TARGETARCH` arg. `docker-compose.yml` has no healthchecks and only plain
`depends_on`, so it maps cleanly with no compose-provider edits.

## Known rough edges

- **`podman compose` provider selection.** Which provider is used depends on what
  is on `PATH`. On a machine with Docker Desktop's `docker-compose` installed,
  that binary wins over `podman-compose`. Both work against the podman socket; if
  you see a `>>>> Executing external compose provider "…docker-compose" <<<<`
  banner, that is expected.
- **colima / `playwright:up`.** The repo's `playwright:up` devenv task starts
  colima and runs a Chromium container with `docker`. Because `DOCKER_HOST` in the
  devenv shell now points at podman, `docker` in that task will target podman, not
  colima. That task was **not** modified by the podman migration and may need a
  follow-up if the E2E flow should keep running on colima (or be moved to podman).
- **Ryuk disabled** ⇒ hard-crashed runs can leak containers (see above).
- **Rootless port binding.** The machine is rootless, so containers can only bind
  host ports ≥ 1024. `docker-compose.yml` uses 3000/3001, so this is fine; switch
  to `--rootful` if you ever need privileged ports.
