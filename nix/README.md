# Nix migration — flake skeleton (2pk)

This directory is the **flake-parts skeleton** for the nix migration (beads
`web_ui_ssr_experiment-2pk`). It is **additive**: `devenv.nix` remains the
**authoritative** environment for daily dev and CI until the cutover task
(**2pk.4**). Nothing here replaces devenv yet.

Design source of truth: basic-memory note *"Nix migration design (2pk.1) — flake
structure + gap closure"* (project `main`).

## Layout

| File | Provides | State |
|------|----------|-------|
| `../flake.nix` | flake-parts entry; pins nixpkgs to devenv.lock's **exact rev** (`devenv-nixpkgs` efff4732) | ✅ |
| `devshell.nix` | `devShells.default` at parity with `devenv.nix` (bun, jdk25+maven, buf, podman, postgres_17, ast-grep, dockerfmt, hadolint, protoc plugins…), DOCKER_HOST wiring, `.env` load, **lefthook install** | ✅ works |
| `lefthook.nix` | git-hooks: renders `../lefthook.yml` from Nix (source of truth for the 8-hook pre-commit set), `packages.lefthook-config` regen target, `checks.lefthook-config-sync` drift guard | ✅ (2pk.2) |
| `codegen.nix` | `packages.rpc-gen` — `buf generate` + wrap-jsonschema (TS/JSON-Schema + Java outputs) | ✅ builds (FOD); /ts + /java byte-identical to devenv |
| `packages-ts.nix` | `packages.node-modules` (node_modules FOD) → `packages.web-ui-ssr` (panda + rsbuild → `dist/`) | ✅ builds |
| `packages-java.nix` | `packages.business-logic-java` (runnable jar + `libs/`), `packages.connect-unary-adapter` | ✅ **builds** (pure `buildMavenPackage`, hermetic jOOQ codegen) |
| `images.nix` | `packages.image-{web-ui-ssr,business-logic-java,pw-browser}` — nix2container OCI images (**x86_64-linux only**) | ✅ eval/build **on Linux**; plumbing smoked on darwin (see below) |
| `arion.nix` | `packages.arion-compose` — Arion "Option A" nix-built compose YAML | ✅ builds on darwin; `podman compose config` clean |
| `checks.nix` | `checks.{node-modules,rpc-gen,web-ui-ssr}` + `ci-biome`, `ci-eslint`, `ci-hygiene` | ✅ all build green |
| `apps.nix` | `apps.{generate,up,e2e}` — impure `nix run` wrappers (`up` = arion-backed) | wired |

### Git hooks — lefthook (2pk.2)

`nix/lefthook.nix` is the **single source of truth** for the pre-commit hook set.
It renders the committed **`../lefthook.yml`** (a `# DO NOT EDIT` generated file);
both shells install the SAME hooks from it, so `nix develop` and `devenv shell`
converge on byte-identical `.git/hooks`:

- **nix devshell** — `devshell.nix` shellHook runs `lefthook install --force`
- **devenv shell** — `devenv.nix` enterShell runs `lefthook install --force`

(`--force` because git-hooks.nix/prek left `core.hooksPath` pinned to the shared
worktree hooks dir; lefthook installs into exactly that dir non-destructively.)
The lefthook binary and every hook tool (buf, biome/eslint/dclint via `bunx`,
dockerfmt, hadolint, ast-grep) come from the devshell PATH — lefthook, unlike
git-hooks.nix, does **not** auto-provision tools from nixpkgs (design note 2pk.1,
Gap 6: the move is lateral — parallel Go runner gained, auto-tools lost).

Regenerate `lefthook.yml` after editing `nix/lefthook.nix`:

```sh
nix build .#lefthook-config && cp -f result lefthook.yml && chmod +w lefthook.yml
```

`checks.lefthook-config-sync` (part of `nix flake check`) fails if the committed
`lefthook.yml` ever drifts from what `nix/lefthook.nix` renders. The 8-hook →
prek parity table (and the 8cc eslint-scoping fix) live in `nix/lefthook.nix`.

> **Toolchain parity.** `flake.nix` pins nixpkgs to devenv.lock's
> **exact commit** (not the moving `rolling`/`master` branches), so tool versions
> match devenv byte-for-byte: **bun 1.3.11**, **protoc 34.0** (⇒ rpc-gen `/java`
> stamps gencode `4.34.0`, honoring `pom.xml`'s invariant), jdk25, go 1.25.2.
> This keeps the from-source plugin hashes copied from `devenv.nix` valid and was
> verified: `rpc-gen`'s `/ts` **and** `/java` are byte-identical to a fresh devenv
> `bun run generate`.

## What works today on aarch64-darwin

```sh
# Dev shell (parity smoke)
nix develop --command bash -c 'bun --version && java --version && mvn --version && buf --version'

# TS build chain (see the --impure note below)
nix build --impure .#node-modules
nix build --impure .#rpc-gen
nix build --impure .#web-ui-ssr     # → ./result/dist (server + client bundles)

# Evaluate the whole flake without building (aarch64-darwin only by default;
# add --all-systems to also evaluate the x86_64-linux outputs)
nix flake check --no-build

# Lint checks (all three build green on aarch64-darwin)
nix build --impure .#checks.aarch64-darwin.ci-biome
nix build --impure .#checks.aarch64-darwin.ci-eslint
nix build --impure .#checks.aarch64-darwin.ci-hygiene

# Java reactor — pure buildMavenPackage incl. hermetic jOOQ codegen (no docker)
nix build --impure .#business-logic-java     # → result/{business-logic-java.jar,libs/}
nix build --impure .#connect-unary-adapter

# Arion "Option A" compose (builds on darwin; consumable by podman/docker compose)
nix build .#arion-compose                    # → result (docker-compose.yaml)
podman compose -f result config              # parses clean
```

## Why `--impure` for the TS builds

`bun.lock` is **gitignored** in this repo (local-only convention). Flakes only
see git-tracked files, so a pure eval cannot read `bun.lock`. The node_modules
FOD therefore reads it from `$PWD` at build time, which requires
`nix build --impure` **invoked from the repo root**.

Under a pure eval (`nix flake check --no-build`) everything still **evaluates**:
the lock path resolves to a tracked placeholder that is never consumed. If the
FOD is ever *realized* without `--impure`, the build **fails fast** with an
explicit pointer —

```
ERROR: bun.lock is gitignored and not visible to a pure build.
       Run 'nix build --impure' from the repo root.
```

— instead of dying deep in bun with a misleading `InvalidLockfileVersion`.

## FOD hash update workflow

Two fixed-output derivations pin network fetches:

- `packages.node-modules` (`bun install`) — bump on **any `bun.lock` change**.
- `packages.rpc-gen` (`buf generate` fetches the `bufbuild/protovalidate` BSR
  module) — bump on proto / `buf.*` / plugin / `wrap-jsonschema.ts` changes.

To update a hash:

1. Set its `outputHash` to `pkgs.lib.fakeHash` (or flip one char).
2. `nix build --impure .#node-modules` (or `.#rpc-gen`).
3. Copy the `got: sha256-…` value from the mismatch error into `outputHash`.

> **Per-system caveat (node-modules).** The pinned `node-modules` hash was
> captured on **aarch64-darwin**. `bun install` pulls platform-specific native
> deps (esbuild / `@rsbuild/core` / playwright-core binaries), so **x86_64-linux**
> (the CI/deploy arch) resolves a *different* closure and needs its **own** hash.
> At cutover, make `outputHash` a per-system lookup (`{ aarch64-darwin = …;
> x86_64-linux = …; }.${system}`). `rpc-gen`'s output is generated code and is
> platform-independent, so its single hash is portable.

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
devenv dev loop the same slot is a warm `~/.m2` populated by the `java:adapter:install`
task (`mvn install` build-bom + adapter). No reactor resolution in either world.

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
   Testcontainers `*IT` stay in the impure devenv path (`devenv tasks run java:verify`).

Both FODs are double-`--rebuild` reproducible. Verified on aarch64-darwin (Java is
arch-portable): `nix build .#connect-unary-adapter` and `nix build .#business-logic-java`
both BUILD SUCCESS incl. hermetic jOOQ codegen.

## Images (`images.nix`) — nix2container, x86_64-linux

Three OCI images via **nix2container** (design gap 4 primary): `image-web-ui-ssr`
(bun + `dist`, **vendor `node_modules` layered BELOW app code**; the server + client
+ manifest + `sw.js` ship as ONE derivation → ONE atomic layer, so no client/server/
sw skew — see the 2pk.5 asset-skew/skew-window note), `image-business-logic-java`
(JRE + runnable jar + `libs/`), and `image-pw-browser` (the SAME digest-pinned
`zenika/alpine-chrome` base as the Dockerfile, overlaid with a musl-static socat +
`run.sh` CDP-bridge supervisor).

**These target `x86_64-linux` only (Fly.io, amd64).** They cannot be `nix eval`'d or
built **from the aarch64-darwin host** — not because of the image code, but because
the pinned `cachix/devenv-nixpkgs` realizes its patched package set via a
per-system `applyPatches` derivation and then `import`s it (an **IFD**). Evaluating
`legacyPackages.x86_64-linux` therefore requires *building* an x86_64-linux
derivation, which needs a Linux builder. This blocks **every** x86_64-linux output
of this flake from darwin (not just images). Realization happens on the Linux CI
agents (**2pk.4**), which also run `nix2container` `copyToRegistry`/`copyToPodman`.

The image **plumbing is smoke-validated on darwin**: temporarily unguarding the
packages to the host system and running `nix build .#packages.aarch64-darwin.image-*`
builds all three end-to-end — buildLayer/buildImage/copyToRoot, the vendor-below-app
split (bun → node_modules → app, with bun deduped out of the upper layers), and the
`pullImage` amd64 base + socat overlay all assemble correctly. (Those aarch64-darwin
images are a plumbing smoke only — not deployable; containers are Linux.)

## Arion (`arion.nix`) — Option A compose

`packages.arion-compose` is the **nix-built** docker-compose file the runtime
consumes (Option A). It mirrors `docker-compose.yml` (postgres + business-logic +
web-ui-ssr) and adds the `pw-browser` CDP service (the devenv `playwright:up`
flags + `host.docker.internal` + a sized `/dev/shm`). Because it references image
**name:tag strings**, the YAML builds on darwin and `podman compose -f … config`
parses clean. A top-level `name: web-ui-ssr-experiment` is injected (post-processed
with `jq`) so the project + `postgres-data` volume identity is pinned in the file
regardless of the invoking cwd (arion only emits the inert `x-arion.project.name`).
`apps.up` brings it up via `podman compose`. Full `up` needs the service images
realized (x86_64-linux) + loaded (`copyToPodman`) on a Linux-capable builder;
postgres pulls + runs standalone regardless.

## Deviations from the design note

- **Images cannot evaluate on darwin** — the design asked images to "evaluate on
  darwin, realize on Linux". The devenv-nixpkgs `applyPatches` IFD (above) makes
  *evaluation* itself require a Linux builder, so both eval and realization are
  Linux-only here. The image derivations are otherwise complete and were smoked via
  the aarch64-darwin plumbing build.
- **`ci-proto-breaking` is not a check** — `buf breaking --against .git#branch=main`
  needs git history a sealed check derivation lacks. It stays a devenv task (a
  `nix run` app at cutover), same impurity class as `ci-e2e`.
- **`ci-e2e` is an app, not a check** (per the design note) — it needs a podman
  Postgres + backend + CDP browser container.
