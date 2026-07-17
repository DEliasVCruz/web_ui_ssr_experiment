# Workspace hygiene: syncpack + bun catalog + sherif + knip

Three tools keep the bun workspaces honest. They have **non-overlapping**
responsibilities so they never fight each other:

| Tool         | Owns                                                        | Fixes? |
| ------------ | ---------------------------------------------------------- | ------ |
| **syncpack** | dependency-version consistency + `workspace:` / range policy | yes (`syncpack fix`) |
| **sherif**   | orthogonal monorepo lints (types placement, ordering, root fields) | lint-only here |
| **knip**     | unused files / exports / dependencies                      | no (manual triage) |

syncpack is the **single authoritative version enforcer**. sherif runs
lint-only and its version rules are disabled, so it is never a second fixer.

## Commands

Root `package.json` scripts (run from the repo root):

```bash
bun run lint:deps         # syncpack lint  — version consistency
bun run fix:deps          # syncpack fix   — autofix version drift
bun run lint:workspaces   # sherif (lint-only, version rules delegated to syncpack)
bun run lint:knip         # knip           — unused files/exports/deps
bun run lint:hygiene      # all three, sequentially
```

Or via the aggregate devenv task (what CI runs):

```bash
devenv tasks run ci:hygiene
```

## Bun catalog (single version source of truth)

Dependencies used by 2+ workspaces live in the root `package.json`
`workspaces.catalog`, and each workspace references them with `catalog:`:

```jsonc
// package.json (root)
"workspaces": {
  "packages": ["packages/*", "services/*"],
  "catalog": {
    "@bufbuild/protobuf": "^2.11.0",
    "@connectrpc/connect": "^2.1.1",
    "@connectrpc/connect-web": "^2.1.1",
    "typescript": "^5.7.2"
  }
}
```

Bumping one of these is now a one-line edit in the catalog. syncpack 15
understands bun catalogs natively (they become `bunCatalog` dependency types)
and treats catalog definitions/consumers as first-class, so it lints them for
consistency without any extra configuration.

## syncpack config (`.syncpackrc.json`)

- **versionGroup** — internal `@web-ui-poc/*` packages must be consumed via the
  `workspace:*` protocol (scoped to `prod`/`dev`/`peer` so it doesn't try to
  rewrite the packages' own `version` field).
- **semverGroups** — codify the repo's existing range policy so drift is caught:
  - `arktype` + `@ark/json-schema` → exact (runtime validator; patch drift is a
    wire-contract risk),
  - `@biomejs/biome` → tilde (a minor bump must not silently change lint/format
    output across the team),
  - everything else → caret (repo default).

`syncpack fix` autofixes any range/consistency drift.

## sherif rules disabled (and why)

sherif runs with three rules turned off:

- `multiple-dependency-versions`, `unsync-similar-dependencies` — these enforce
  version consistency, which is **syncpack's** job. Disabling them keeps syncpack
  the single source of truth (no two tools disagreeing on the canonical version).
- `packages-without-package-json` — the `packages/*` glob legitimately includes
  `packages/java`, a Maven-only reactor module (`pom.xml`, no `package.json`).
  Without this off, sherif emits a perpetual false-positive warning. sherif can't
  ignore a directory that has no `package.json` to match by name, so the rule
  itself is disabled.

`--fail-on-warnings` makes the remaining warning-level rules
(`non-existant-packages`, `root-package-dependencies`) actually gate.

## knip config (`knip.jsonc`)

- `ignoreExportsUsedInFile: true` — a few exports are consumed only within their
  own module (the e2e fixture base-URL constants, the Ark UI toaster singleton).
  They aren't cross-module imports, so knip's "unused export" report is a false
  positive; suppressing it beats un-exporting working code.
- Root `entry: ["tooling/eslint/ci.ts"]` — that config is loaded via
  `eslint --config …` (the `ci:eslint` task), never imported, so knip can't infer
  it is reachable.
- Root `ignoreDependencies`:
  - `@bufbuild/protoc-gen-es`, `@connectrpc/protoc-gen-connect-query` — buf codegen
    plugins invoked as `local:` protoc plugins in `buf.gen.yaml` (not importable JS).
  - `solid-refresh` — the Solid HMR babel transform. `@rsbuild/plugin-solid` injects
    it into the dev client build; `rsbuild.config.ts` only references it by string
    (to strip it from the SSR build), so there is no static import for knip to see.
- `packages/rpc` `ignoreDependencies: ["@bufbuild/protobuf"]` — that package is
  nothing but buf-generated code under `gen/` (gitignored, so knip can't scan it).
  The generated `todo_pb.ts` imports `@bufbuild/protobuf`; it's a real dependency,
  invisible to knip only because the code is generated.

### Dead code removed during setup

- `@connectrpc/connect` was removed from `packages/rpc` — the generated code
  imports only `@bufbuild/protobuf`; `@connectrpc/connect` was a genuinely unused
  declaration (the Connect client is provided by the consuming services, which
  declare it themselves).
