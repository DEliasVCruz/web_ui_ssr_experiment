# Nix flake — dev shell + build/CI entry points (2pk)

This directory is the **flake-parts implementation** for the nix migration (beads
`web_ui_ssr_experiment-2pk`). As of the cutover (**2pk.4**) it is the **only**
environment: `nix develop` is the dev shell and `nix run .#<app>` runs every
build/lint/CI workflow. **devenv has been retired** — `devenv.nix` no longer
drives dev or CI.

Design source of truth: basic-memory note *"Nix migration design (2pk.1) — flake
structure + gap closure"* (project `main`).

## Layout

| File | Provides | State |
|------|----------|-------|
| `../flake.nix` | flake-parts entry; pins nixpkgs to plain **nixos-unstable** (`61b7c44c`, 2pk.4 — replaced `devenv-nixpkgs`, dropping its `applyPatches` IFD) | ✅ |
| `devshell.nix` | `devShells.default` — the sole dev shell (bun, jdk25+maven, buf, podman, postgres_17, ast-grep, protoc plugins, nixfmt, shellcheck…; dockerfmt/hadolint dropped in 1vl), DOCKER_HOST wiring, `.env` load, per-unit bun install, **lefthook install** | ✅ works |
| `lefthook.nix` | git-hooks: renders `../lefthook.yml` from Nix (source of truth for the 5-hook pre-commit set), `packages.lefthook-config` regen target, `checks.lefthook-config-sync` drift guard | ✅ (2pk.2) |
| `../packages/rpc/nix` | `packages.rpc-gen` — `buf generate` + wrap-jsonschema (TS/JSON-Schema + Java outputs) | ✅ builds (FOD); deterministic (double `--rebuild`) |
| `../services/web-ui-ssr/nix` | `packages.web-ui-ssr-node-modules` (FOD) → `packages.web-ui-ssr` (panda + rsbuild → `dist/`) | ✅ builds |
| `../tooling/nix` | `packages.tooling-node-modules` (lint toolchain FOD) | ✅ builds |
| `../packages/java/connect-unary-adapter/nix` | `packages.connect-unary-adapter` (adapter jar + pom) | ✅ **builds** (pure `buildMavenPackage`; de-reactored 517) |
| `../services/business-logic-java/nix` | `packages.business-logic-java` (runnable jar + `libs/`; injects the pre-built adapter) | ✅ **builds** (pure `buildMavenPackage`, hermetic jOOQ codegen; de-reactored 517) |
| `images.nix` | `packages.image-{web-ui-ssr,business-logic-java,pw-browser}` — nix2container OCI images (**aarch64-linux realized**, x86_64-linux evaluable) | ✅ realized via `.#build-images` through the builder VM; loaded + run (1vl) |
| `arion.nix` | `packages.arion-compose` — Arion "Option A" nix-built compose YAML | ✅ builds on darwin; `podman compose config` clean |
| `checks.nix` | the FOD/build packages surfaced as checks (`tooling-node-modules`, `rpc-node-modules`, `web-ui-ssr-node-modules`, `rpc-gen`, `web-ui-ssr`, `connect-unary-adapter`, `business-logic-java`, `java-shared-build-config-sync`) + the lint checks `ci-biome`/`ci-eslint`/`ci-hygiene`; plus `lefthook-config-sync` (from `lefthook.nix`) — 12 checks total | ✅ `nix flake check` green |
| `apps.nix` | the full `nix run .#<app>` set — impure `nix run` wrappers (`up` = arion-backed) | wired |

### `nix run .#<app>` — the app set (replaces every former devenv task)

| App | Runs |
|-----|------|
| `.#generate` | `buf generate` → TS (`packages/rpc/gen`) + Java sources |
| `.#ts-check` | TypeScript typecheck |
| `.#buf-format` / `.#buf-format-check` / `.#buf-lint` | proto format / format-check / lint |
| `.#biome-check` / `.#biome-fix` / `.#biome-format` / `.#biome-lint` | Biome check / fix / format / lint |
| `.#eslint-check` / `.#eslint-fix` / `.#eslint-check-all` | ESLint check / fix / check-all |
| `.#java-adapter-install` / `.#java-build` / `.#java-verify` | Java build-bom+adapter install / package jar / full ordered verify |
| `.#playwright-up` / `.#playwright-down` | E2E Chromium container up / down (the pw-browser **nix2container** image, realized via the builder if absent) |
| `.#ci-biome` / `.#ci-eslint` / `.#ci-lint` / `.#ci-hygiene` / `.#ci-e2e` / `.#ci-proto-breaking` | aggregate CI gates |
| `.#linux-builder` | start\|status\|stop the repo-scoped **aarch64-linux builder VM** (1vl — no host mutation) |
| `.#build-images` | realize the 3 aarch64-linux OCI images through the builder → **`podman load`** |
| `.#up` / `.#down` | local stack up / down (arion-backed podman compose; images from `.#build-images`) |

> The Dockerfile/compose lint apps (`docker-fmt`/`docker-lint`/`compose-lint`)
> were **removed** in 1vl along with all Dockerfiles + `docker-compose.yml`.

### Git hooks — lefthook (2pk.2)

`nix/lefthook.nix` is the **single source of truth** for the pre-commit hook set.
It renders the committed **`../lefthook.yml`** (a `# DO NOT EDIT` generated file);
the dev shell installs the hooks from it into `.git/hooks`:

- **nix devshell** — `devshell.nix` shellHook runs `lefthook install --force`

(Historically the retired devenv shell installed the *same* generated hooks, so
the two shells produced byte-identical `.git/hooks` during the migration.)

(`--force` because git-hooks.nix/prek left `core.hooksPath` pinned to the shared
worktree hooks dir; lefthook installs into exactly that dir non-destructively.)
The lefthook binary and every hook tool (buf, biome/eslint, ast-grep; the
dockerfmt/hadolint/dclint hooks were dropped in 1vl) come from the devshell PATH —
lefthook, unlike
git-hooks.nix, does **not** auto-provision tools from nixpkgs (design note 2pk.1,
Gap 6: the move is lateral — parallel Go runner gained, auto-tools lost).

Regenerate `lefthook.yml` after editing `nix/lefthook.nix`:

```sh
nix build .#lefthook-config && cp -f result lefthook.yml && chmod +w lefthook.yml
```

`checks.lefthook-config-sync` (part of `nix flake check`) fails if the committed
`lefthook.yml` ever drifts from what `nix/lefthook.nix` renders. The 5-hook →
prek parity table (and the 8cc eslint-scoping fix) live in `nix/lefthook.nix`.

**Biome hook ⇄ CI alignment (5cn):** the pre-commit `biome` hook runs
`--config-path tooling/biome/ci.json` — the **same** config as the `ci-biome`
gate — so a hook-green commit is `ci-biome`-green for its staged files (no more
"passes the hook, fails CI" gap on the ~15 type-aware nursery rules). It stays
fast (ci config adds ~80–100 ms; whole-repo `check` ~0.5 s) and never mutates on
those rules: they are diagnostic-only, so the hook's `--write` (safe fixes only)
reports-and-blocks without touching the file. Rationale in `nix/lefthook.nix`.

> **Toolchain (2pk.4).** `flake.nix` pins nixpkgs to plain **nixos-unstable**
> (`61b7c44c`), which provides: **bun 1.3.13**, **protoc 35.1** (⇒ rpc-gen `/java`
> stamps gencode `4.35.1`, which exactly meets `build-bom`'s `protobuf-java 4.35.1`
> runtime pin — gencode ≤ runtime holds), **lefthook 2.1.5** (2.x — the last
> stable channel only ships 1.13.x), **jdk25 25.0.3**, **maven 3.9.16**,
> shellcheck 0.11, ast-grep 0.44, nixfmt 1.4, postgresql_17 17.10,
> podman 5.8.4 (dockerfmt/hadolint dropped in 1vl). Repinning off
> `devenv-nixpkgs` re-pinned every FOD (rpc-gen + both
> Maven `mvnHash`es; the 3 bun `node_modules` FODs rebuilt identically), each
> re-proven with double `nix build --rebuild`.

## What works today on aarch64-darwin

```sh
# Dev shell (parity smoke)
nix develop --command bash -c 'bun --version && java --version && mvn --version && buf --version'

# TS build chain (all pure — committed bun.lock; no --impure)
nix build .#rpc-node-modules .#tooling-node-modules .#web-ui-ssr-node-modules
nix build .#rpc-gen
nix build .#web-ui-ssr              # → ./result/dist (server + client bundles)

# Evaluate the whole flake without building (aarch64-darwin only by default;
# add --all-systems to also evaluate the x86_64-linux outputs)
nix flake check --no-build

# Lint checks (all build green on aarch64-darwin)
nix build .#checks.aarch64-darwin.ci-biome
nix build .#checks.aarch64-darwin.ci-eslint
nix build .#checks.aarch64-darwin.ci-hygiene

# Java units — per-unit pure buildMavenPackage incl. hermetic jOOQ codegen (no docker,
# no reactor; de-reactored 517). Both are pure (committed sources), no --impure needed.
nix build .#business-logic-java     # → result/{business-logic-java.jar,libs/}
nix build .#connect-unary-adapter

# Arion "Option A" compose (builds on darwin; consumable by podman/docker compose)
nix build .#arion-compose                    # → result (docker-compose.yaml)
podman compose -f result config              # parses clean
```

## Purity — no `--impure`

Every per-unit `bun.lock` is **committed** (de-workspaced 5ae), so the flake
sees them as git-tracked and all builds are **pure** — no `--impure` and no
`$PWD` reads. (This was the whole point of committing the lockfiles.)

## FOD hash update workflow

The fixed-output derivations that pin network fetches:

- `packages.{rpc,tooling,web-ui-ssr}-node-modules` (`bun install`) — bump the
  matching FOD on a change to that unit's `bun.lock`.
- `packages.rpc-gen` (`buf generate` fetches the `bufbuild/protovalidate` BSR
  module) — bump on proto / `buf.*` / plugin / `wrap-jsonschema.ts` changes.
- the two Maven FODs (`connect-unary-adapter` / `business-logic-java` `mvnHash`)
  — bump on a dependency change or a maven/jdk bump.

To update a hash:

1. Set its `outputHash` / `mvnHash` to `pkgs.lib.fakeHash` (or flip one char).
2. `nix build .#<attr>` (e.g. `.#rpc-node-modules`, `.#rpc-gen`).
3. Copy the `got: sha256-…` value from the mismatch error into the hash.
4. Prove determinism: `nix build .#<attr> --rebuild` twice.

> **Per-system node_modules hash (1vl).** `bun install` pulls platform-specific
> native deps (esbuild / `@rsbuild/core` / lightningcss / playwright-core
> binaries), so each system resolves a *different* closure → a different FOD
> hash. `web-ui-ssr-node-modules` now keys `outputHash` by `system`
> (`services/web-ui-ssr/nix/default.nix`):
>
> | system | web-ui-ssr-node-modules `outputHash` | how captured |
> |--------|--------------------------------------|--------------|
> | `aarch64-darwin` | `sha256-SJXPOJ1WgHKvtaEECeXztTIiI4OhQFz2MBUhPk8+FCE=` | 2pk (darwin), unchanged |
> | `aarch64-linux`  | `sha256-4yxVKbRgHiuyS8gtHDv1JvSksst4xcpAUbbTrDPO/yI=` | 1vl — through the linux-builder VM; double `--rebuild --check` reproduced it |
> | `x86_64-linux`   | placeholder (`AAAA…`) | parked (Fly ruling); eval-only, recapture on an x86_64 builder |
>
> **`rpc-gen` and both Maven `mvnHash`es ARE system-portable** (verified 1vl by
> realizing all three on the aarch64-linux builder — no mismatch): rpc-gen emits
> platform-independent generated code, and the Maven `.m2` is portable jars.
> `rpc-node-modules` is also portable (pure-JS buf plugins). One cross-platform
> BUILD bug was fixed for realization on Linux: node/bash helpers with
> `#!/usr/bin/env …` shebangs fail in the **Linux** nix sandbox (no
> `/usr/bin/env`; darwin has `sandbox = false`), so `rpc-gen` wraps its buf
> plugins with absolute-path launchers and the web-ui-ssr / business-logic
> builds `patchShebangs` their tool scripts. Output is byte-identical, so no FOD
> hash changed.

## Java build — de-reactored, per-unit FODs (2pk.3, de-reactored in 517)

De-reactored (task 517): there is **no** root reactor/parent pom. Each Java unit is
its own standalone `maven.buildMavenPackage`, with its nix module in its own directory:

- `packages/java/connect-unary-adapter/nix/default.nix` → `packages.connect-unary-adapter`
  (the adapter jar + its pom).
- `services/business-logic-java/nix/default.nix` → `packages.business-logic-java`
  (the runnable server jar + `libs/`).

`packages/java/build-bom` is a **pom-only** unit (shared dependency-version BOM); it
has no derivation — each build just `mvn -N install`s its pom into the local repo.

**Adapter bridge.** In the old reactor the adapter was rebuilt from source in the
service's session. Now `packages.business-logic-java` consumes the adapter as an
explicit artifact: it injects the **pre-built** `packages.connect-unary-adapter` jar
+ pom into its offline `.m2` with `install:install-file` (in `preBuild`/`afterDepsSetup`),
sourcing from the adapter's own derivation output — never rebuilt from source. In the
dev loop the same slot is a warm `~/.m2` populated by `nix run .#java-adapter-install`
(`mvn install` build-bom + adapter). No reactor resolution in either world.

The hard part remains the `jooq-codegen` seam in the service: at `generate-sources`
the pom runs `scripts/jooq-codegen.sh`, which starts an **ephemeral postgres over
loopback** (initdb/pg_ctl — no docker socket) and then a **nested single-module
`mvn -Pjooq-codegen flyway:migrate jooq-codegen:generate`**. That nested mvn does not
inherit the outer build's flags, so it would hit the network for the flyway +
jooq-codegen plugins — fatal in the sealed offline phase. Solution, per unit, no
`manualMvnArtifacts` guesswork:

1. **`buildOffline = false`** (default) — the phase-1 FOD runs the *full* online
   `mvn package`, byte-for-byte the phase-2 build, so the FOD's `.m2` provably
   captures every artifact the offline build needs (jOOQ/Flyway profile plugins,
   the adapter's transitive closure, …).
2. **`MAVEN_ARGS` threaded per phase** so the nested mvn shares the outer repo:
   phase-1 `preBuild` exports `-Dmaven.repo.local=$out/.m2` (online); phase-2 sets
   `-o -Dmaven.repo.local=$mvnDeps/.m2` in `afterDepsSetup` (offline). The script
   already forwards `$MAVEN_ARGS` into the nested mvn.
3. **build-bom + adapter resolvable** — each phase pre-installs the build-bom pom
   (`mvn -N install`) and, for the service, injects the pre-built adapter
   (`install:install-file`). The `com/webuipoc` group + `maven-metadata-local.xml`
   they write are **scrubbed** in the FOD `postInstall` (wall-clock stamps) and
   re-injected in phase-2 — the same determinism discipline the reactor used.
4. **buf-generated Java** copied from `packages.rpc-gen`'s `/java` before each service
   build (the adapter has no generated sources).
5. **`mvnHash`** pinned per unit (fakeHash → read the mismatch); changes on any
   dep/plugin bump. **`doCheck = false`**: the adapter's pure tests and the service's
   Testcontainers `*IT` stay in the impure app path (`nix run .#java-verify`).

Both FODs are double-`--rebuild` reproducible. Verified on aarch64-darwin (Java is
arch-portable): `nix build .#connect-unary-adapter` and `nix build .#business-logic-java`
both BUILD SUCCESS incl. hermetic jOOQ codegen.

## Images (`images.nix`) — nix2container, aarch64-linux (realized, 1vl)

Three OCI images via **nix2container** (design gap 4 primary): `image-web-ui-ssr`
(bun + `dist`, **vendor `node_modules` layered BELOW app code**; the server + client
+ manifest + `sw.js` ship as ONE derivation → ONE atomic layer, so no client/server/
sw skew — see the 2pk.5 asset-skew/skew-window note), `image-business-logic-java`
(JRE + runnable jar + `libs/`), and `image-pw-browser` (the SAME digest-pinned
`zenika/alpine-chrome:124` base the deleted Dockerfile used, overlaid with a
musl-static socat + `run.sh` CDP-bridge supervisor).

**Realized target: `aarch64-linux`** (podman-machine native — Daniel's 1vl
ruling; the old x86_64/Fly ruling is parked). `x86_64-linux` stays **evaluable**
(its outputs resolve under `nix flake check --no-build --all-systems`) but is not
realized here. Per-system where it matters: the `web-ui-ssr-node-modules` FOD
hash (table above) and the pw-browser base (multi-arch `zenika/alpine-chrome:124`
— `imageDigest` + NAR `sha256` + `arch` selected per system; the …88859dd…
digest is the **arm64** manifest).

### Realizing + loading them (no host mutation, 1vl)

Realizing Linux images on this aarch64-darwin host needs an aarch64-linux
builder. `nix run .#linux-builder start` boots a **repo-scoped**
`nixpkgs#darwin.linux-builder` QEMU VM (Hypervisor.framework) that authorizes a
self-generated key from `~/.cache/web-ui-ssr-linux-builder/` and forwards guest
ssh → host `:31022`. **No host mutation**: no `/etc/nix` edits, no
`nix.linux-builder.enable`, no sudo. Because macOS nix is multi-user (so
`--builders` would make the *root* daemon ssh — key-ownership friction), the VM
is driven entirely **client-side as the invoking user**: `nix run .#build-images`
exports each derivation closure over ssh, `nix-store --realise`s it on the VM,
exports the result back, then `skopeo copy nix:… docker-archive:` + `podman load`
into the machine.

Lifecycle / cost: `nix run .#linux-builder {start|status|stop}`. First `start`
pulls the NixOS VM image and creates a ~20 GB sparse `nixos.qcow2` under
`~/.cache/web-ui-ssr-linux-builder/` (persists across runs; delete that dir to
reclaim). The VM is 1 CPU / 3 GiB by default — enough to build all three images
(the maven/jOOQ + rsbuild steps take a few minutes each on first realize; cached
after). `stop` kills the qemu process.

Proven (1vl): all three realize through the builder, `podman load` into the
machine (`podman images` shows `web-ui-ssr-experiment/web-ui-ssr:latest`,
`…/business-logic-java:latest`, `…/pw-browser:local`), and RUN — the arion
stack serves SSR + RPC end-to-end (below), and the pw-browser image answers CDP
with the socat supervisor intact (kill socat → container exits ≤ 1 s).

## Arion (`arion.nix`) — Option A compose

`packages.arion-compose` is the **nix-built** docker-compose file the runtime
consumes (Option A) — it fully **replaces** the deleted `docker-compose.yml`. It
declares postgres (upstream `postgres:17-alpine`) + business-logic + web-ui-ssr +
the `pw-browser` CDP service (the `nix run .#playwright-up` flags +
`host.docker.internal` + a sized `/dev/shm`). Because it references image
**name:tag strings**, the YAML builds on darwin and `podman compose -f … config`
parses clean. A top-level `name: web-ui-ssr-experiment` is injected (post-processed
with `jq`) so the project + `postgres-data` volume identity is pinned in the file
regardless of the invoking cwd (arion only emits the inert `x-arion.project.name`).

`nix run .#up` brings it up via `podman compose` (`.#down` tears it down). Load the
nix service images first with `nix run .#build-images`; postgres pulls + runs
standalone regardless. **Verified end-to-end (1vl):** `up` → postgres healthy →
business-logic answers `ListTodos` (and `CreateTodo` seeds) → web-ui-ssr SSRs the
`/todos` list server-side (the backend logs the SSR `ListTodos` fetch) → `down`
removes every container + the network cleanly.

## Deviations from the design note

- **Images realize on aarch64-linux via a repo-scoped builder VM (1vl)** — evaluated
  on darwin, realized through `nix run .#linux-builder` + `.#build-images` and loaded
  into podman with `podman load` (client-side ssh; NO host mutation). The old
  x86_64/Fly target is parked but kept evaluable.
- **`ci-proto-breaking` is not a check** — `buf breaking --against .git#branch=main`
  needs git history a sealed check derivation lacks. It is a `nix run .#ci-proto-breaking`
  app (not a flake check), same impurity class as `ci-e2e`.
- **`ci-e2e` is an app, not a check** (per the design note) — it needs a podman
  Postgres + backend + CDP browser container.
