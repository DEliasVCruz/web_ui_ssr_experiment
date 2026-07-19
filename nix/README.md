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
| `devshell.nix` | `devShells.default` — the sole dev shell (bun, jdk25+maven, buf, podman, postgres_17, ast-grep, dockerfmt, hadolint, protoc plugins, nixfmt, shellcheck…), DOCKER_HOST wiring, `.env` load, per-unit bun install, **lefthook install** | ✅ works |
| `lefthook.nix` | git-hooks: renders `../lefthook.yml` from Nix (source of truth for the 8-hook pre-commit set), `packages.lefthook-config` regen target, `checks.lefthook-config-sync` drift guard | ✅ (2pk.2) |
| `../packages/rpc/nix` | `packages.rpc-gen` — `buf generate` + wrap-jsonschema (TS/JSON-Schema + Java outputs) | ✅ builds (FOD); deterministic (double `--rebuild`) |
| `packages-ts.nix` | `packages.node-modules` (node_modules FOD) → `packages.web-ui-ssr` (panda + rsbuild → `dist/`) | ✅ builds |
| `../packages/java/connect-unary-adapter/nix` | `packages.connect-unary-adapter` (adapter jar + pom) | ✅ **builds** (pure `buildMavenPackage`; de-reactored 517) |
| `../services/business-logic-java/nix` | `packages.business-logic-java` (runnable jar + `libs/`; injects the pre-built adapter) | ✅ **builds** (pure `buildMavenPackage`, hermetic jOOQ codegen; de-reactored 517) |
| `images.nix` | `packages.image-{web-ui-ssr,business-logic-java,pw-browser}` — nix2container OCI images (**x86_64-linux only**) | ✅ eval/build **on Linux**; plumbing smoked on darwin (see below) |
| `arion.nix` | `packages.arion-compose` — Arion "Option A" nix-built compose YAML | ✅ builds on darwin; `podman compose config` clean |
| `checks.nix` | `checks.{node-modules,rpc-gen,web-ui-ssr}` + `ci-biome`, `ci-eslint`, `ci-hygiene` | ✅ all build green |
| `apps.nix` | the full `nix run .#<app>` set — impure `nix run` wrappers (`up` = arion-backed) | wired |

### `nix run .#<app>` — the app set (replaces every former devenv task)

| App | Runs |
|-----|------|
| `.#generate` | `buf generate` → TS (`packages/rpc/gen`) + Java sources |
| `.#ts-check` | TypeScript typecheck |
| `.#buf-format` / `.#buf-format-check` / `.#buf-lint` | proto format / format-check / lint |
| `.#biome-check` / `.#biome-fix` / `.#biome-format` / `.#biome-lint` | Biome check / fix / format / lint |
| `.#eslint-check` / `.#eslint-fix` / `.#eslint-check-all` | ESLint check / fix / check-all |
| `.#docker-fmt` / `.#docker-fmt-check` / `.#docker-lint` | Dockerfile format / format-check / lint (hadolint) |
| `.#compose-lint` / `.#compose-lint-fix` | compose (dclint) lint / lint-fix |
| `.#java-adapter-install` / `.#java-build` / `.#java-verify` | Java build-bom+adapter install / package jar / full ordered verify |
| `.#playwright-up` / `.#playwright-down` | E2E Chromium container up / down |
| `.#ci-biome` / `.#ci-eslint` / `.#ci-lint` / `.#ci-hygiene` / `.#ci-e2e` / `.#ci-proto-breaking` | aggregate CI gates |
| `.#up` | local stack (arion-backed podman compose) |

### Git hooks — lefthook (2pk.2)

`nix/lefthook.nix` is the **single source of truth** for the pre-commit hook set.
It renders the committed **`../lefthook.yml`** (a `# DO NOT EDIT` generated file);
the dev shell installs the hooks from it into `.git/hooks`:

- **nix devshell** — `devshell.nix` shellHook runs `lefthook install --force`

(Historically the retired devenv shell installed the *same* generated hooks, so
the two shells produced byte-identical `.git/hooks` during the migration.)

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

> **Toolchain (2pk.4).** `flake.nix` pins nixpkgs to plain **nixos-unstable**
> (`61b7c44c`), which provides: **bun 1.3.13**, **protoc 35.1** (⇒ rpc-gen `/java`
> stamps gencode `4.35.1`, which exactly meets `build-bom`'s `protobuf-java 4.35.1`
> runtime pin — gencode ≤ runtime holds), **lefthook 2.1.5** (2.x — the last
> stable channel only ships 1.13.x), **jdk25 25.0.3**, **maven 3.9.16**,
> **dockerfmt 0.5.4** (now packaged; the from-source `buildGoModule` is retired),
> hadolint 2.14, shellcheck 0.11, ast-grep 0.44, nixfmt 1.4, postgresql_17 17.10,
> podman 5.8.4. Repinning off `devenv-nixpkgs` re-pinned every FOD (rpc-gen + both
> Maven `mvnHash`es; the 3 bun `node_modules` FODs rebuilt identically), each
> re-proven with double `nix build --rebuild`.

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

# Java units — per-unit pure buildMavenPackage incl. hermetic jOOQ codegen (no docker,
# no reactor; de-reactored 517). Both are pure (committed sources), no --impure needed.
nix build .#business-logic-java     # → result/{business-logic-java.jar,libs/}
nix build .#connect-unary-adapter

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

## Images (`images.nix`) — nix2container, x86_64-linux

Three OCI images via **nix2container** (design gap 4 primary): `image-web-ui-ssr`
(bun + `dist`, **vendor `node_modules` layered BELOW app code**; the server + client
+ manifest + `sw.js` ship as ONE derivation → ONE atomic layer, so no client/server/
sw skew — see the 2pk.5 asset-skew/skew-window note), `image-business-logic-java`
(JRE + runnable jar + `libs/`), and `image-pw-browser` (the SAME digest-pinned
`zenika/alpine-chrome` base as the Dockerfile, overlaid with a musl-static socat +
`run.sh` CDP-bridge supervisor).

**These target `x86_64-linux` only (Fly.io, amd64).** As of **2pk.4** they DO
**evaluate from the aarch64-darwin host** — repinning off `cachix/devenv-nixpkgs`
to plain nixos-unstable removed its per-system `applyPatches` IFD, so
`legacyPackages.x86_64-linux` no longer needs a Linux builder just to evaluate.
Proven: `nix flake check --no-build --all-systems` passes from darwin and
`nix eval .#packages.x86_64-linux.image-*.drvPath` resolves. They still cannot be
**realized** (built) on darwin — that needs an x86_64-linux builder for the Linux
closure. Realization + `nix2container` `copyToRegistry`/`copyToPodman` happen on
the Linux CI agents.

The image **plumbing is smoke-validated on darwin**: temporarily unguarding the
packages to the host system and running `nix build .#packages.aarch64-darwin.image-*`
builds all three end-to-end — buildLayer/buildImage/copyToRoot, the vendor-below-app
split (bun → node_modules → app, with bun deduped out of the upper layers), and the
`pullImage` amd64 base + socat overlay all assemble correctly. (Those aarch64-darwin
images are a plumbing smoke only — not deployable; containers are Linux.)

## Arion (`arion.nix`) — Option A compose

`packages.arion-compose` is the **nix-built** docker-compose file the runtime
consumes (Option A). It mirrors `docker-compose.yml` (postgres + business-logic +
web-ui-ssr) and adds the `pw-browser` CDP service (the `nix run .#playwright-up`
flags + `host.docker.internal` + a sized `/dev/shm`). Because it references image
**name:tag strings**, the YAML builds on darwin and `podman compose -f … config`
parses clean. A top-level `name: web-ui-ssr-experiment` is injected (post-processed
with `jq`) so the project + `postgres-data` volume identity is pinned in the file
regardless of the invoking cwd (arion only emits the inert `x-arion.project.name`).
`apps.up` brings it up via `podman compose`. Full `up` needs the service images
realized (x86_64-linux) + loaded (`copyToPodman`) on a Linux-capable builder;
postgres pulls + runs standalone regardless.

## Deviations from the design note

- **Images evaluate on darwin, realize on Linux** — as the design asked. The 2pk.4
  repin to plain nixpkgs removed the `devenv-nixpkgs` `applyPatches` IFD that had
  blocked cross-system *evaluation*; `nix flake check --all-systems` now evaluates
  the x86_64-linux image derivations from the darwin host. Realization stays
  Linux-only (Linux closure). The image derivations were also smoked via the
  aarch64-darwin plumbing build.
- **`ci-proto-breaking` is not a check** — `buf breaking --against .git#branch=main`
  needs git history a sealed check derivation lacks. It is a `nix run .#ci-proto-breaking`
  app (not a flake check), same impurity class as `ci-e2e`.
- **`ci-e2e` is an app, not a check** (per the design note) — it needs a podman
  Postgres + backend + CDP browser container.
