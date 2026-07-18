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
| `../flake.nix` | flake-parts entry; pins nixpkgs to devenv's (`cachix/devenv-nixpkgs/rolling`) | ✅ |
| `devshell.nix` | `devShells.default` at parity with `devenv.nix` (bun, jdk25+maven, buf, podman, postgres_17, ast-grep, dockerfmt, hadolint, protoc plugins…), DOCKER_HOST wiring, prek git-hooks install | ✅ works |
| `codegen.nix` | `packages.rpc-gen` — `buf generate` + wrap-jsonschema (TS/JSON-Schema + Java outputs) | ✅ builds (FOD) |
| `packages-ts.nix` | `packages.node-modules` (node_modules FOD) → `packages.web-ui-ssr` (panda + rsbuild → `dist/`) | ✅ builds |
| `packages-java.nix` | `packages.business-logic-java`, `packages.connect-unary-adapter` | ⛔ **stubbed** (fail-at-build) |
| `checks.nix` | `checks.{node-modules,rpc-gen,web-ui-ssr}` + `ci-biome`, `ci-eslint`, `ci-hygiene` | ✅ all build green |
| `apps.nix` | `apps.{generate,up,e2e}` — impure `nix run` wrappers | wired |

## What works today on aarch64-darwin

```sh
# Dev shell (parity smoke)
nix develop --command bash -c 'bun --version && java --version && mvn --version && buf --version'

# TS build chain (see the --impure note below)
nix build --impure .#node-modules
nix build --impure .#rpc-gen
nix build --impure .#web-ui-ssr     # → ./result/dist (server + client bundles)

# Evaluate the whole flake without building
nix flake check --no-build

# Lint checks (all three build green on aarch64-darwin)
nix build --impure .#checks.aarch64-darwin.ci-biome
nix build --impure .#checks.aarch64-darwin.ci-eslint
nix build --impure .#checks.aarch64-darwin.ci-hygiene
```

## Why `--impure` for the TS builds

`bun.lock` is **gitignored** in this repo (local-only convention). Flakes only
see git-tracked files, so a pure eval cannot read `bun.lock`. The node_modules
FOD therefore reads it from `$PWD` at build time, which requires
`nix build --impure` **invoked from the repo root**. Under a pure eval
(`nix flake check --no-build`) the lock path falls back to a tracked file so
evaluation still succeeds — those paths never realize the FOD, so the fallback
is never installed.

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

## What is stubbed and why (honesty)

`packages.business-logic-java` / `packages.connect-unary-adapter` **evaluate**
(so `nix flake check --no-build` passes) but **fail at build** with the precise
remaining work. A pure `maven.buildMavenPackage` is blocked on:

1. **buf-generated Java sources** — must copy `rpc-gen`'s `/java` output into
   `services/business-logic-java/generated-sources/{protobuf,grpc}` before the
   maven build. (Ready to thread in.)
2. **jOOQ codegen offline-repo gap** — at `generate-sources` the pom runs
   `scripts/jooq-codegen.sh`, which launches an ephemeral postgres (fine in a
   sandbox) and then a **nested `mvn -Pjooq-codegen …`** that does **not** inherit
   the outer `buildMavenPackage`'s `-o -Dmaven.repo.local=…`. In a sealed offline
   build it tries to fetch the flyway + jooq-codegen plugins from the network and
   fails. Closing it needs the `jooq-codegen` profile's plugin closure
   pre-populated into the offline `.m2` (`manualMvnArtifacts` / `buildOffline`) and
   `MAVEN_ARGS` threaded into `jooq-codegen.sh`. Owned by task **2pk.6**.
3. **`mvnHash`** — pin after (1)+(2) build; changes on any dep/plugin bump.

The full `buildMavenPackage` shape for the follow-up is in `packages-java.nix`.

## Deviations from the design note

- **`images.nix` / `arion.nix` are not included** — image builds and the Arion
  compose are task **2pk.3**, out of scope for the skeleton. `apps.up` is a thin
  `podman compose` placeholder until then.
- **`ci-proto-breaking` is not a check** — `buf breaking --against .git#branch=main`
  needs git history a sealed check derivation lacks. It stays a devenv task (a
  `nix run` app at cutover), same impurity class as `ci-e2e`.
- **`ci-e2e` is an app, not a check** (per the design note) — it needs a podman
  Postgres + backend + CDP browser container.
