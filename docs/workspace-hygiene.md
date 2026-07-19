# Workspace hygiene: syncpack + knip + dependency-cruiser

The repo is **de-workspaced** (5ae): there is no root `package.json` and no bun
workspace/catalog. Each TS unit (`tooling`, `packages/rpc`, `services/web-ui-ssr`)
is self-contained with its own `package.json` + committed `bun.lock`. Three tools
keep those units honest, with **non-overlapping** responsibilities:

| Tool                    | Owns                                                     | Fixes? |
| ----------------------- | ------------------------------------------------------- | ------ |
| **syncpack**            | dependency-version consistency + range policy           | yes (`syncpack fix`) |
| **knip** (per unit)     | unused files / exports / dependencies                   | no (manual triage) |
| **dependency-cruiser**  | module boundaries / import direction                    | no (fix the import) |

syncpack is the **single authoritative version enforcer**. (`sherif` was dropped
in the de-workspacing — it is a bun-workspace linter with no non-workspace mode,
and there is no longer a workspace root for it to analyse.)

## Commands

Run the aggregate hygiene gate (what CI runs) from the repo root inside
`nix develop`:

```bash
nix run .#ci-hygiene
```

That runs, in order: `syncpack lint`, `knip` once **per unit** (`tooling`,
`packages/rpc`, `services/web-ui-ssr` — knip needs a `package.json` root and there
is no longer a workspace root), then `depcruise services packages`. To autofix
version drift specifically: `tooling/node_modules/.bin/syncpack fix` from the root.

## syncpack config (`.syncpackrc.json`)

- **versionGroup** — the internal `@web-ui-poc/*` packages are de-workspaced and
  consumed via `file:` relative paths (local specifiers, not semver), so syncpack
  **ignores** them (`isIgnored: true`) rather than enforcing a `workspace:` protocol.
- **semverGroups** — codify the repo's range policy so drift is caught:
  - `arktype` + `@ark/json-schema` → exact (runtime validator; patch drift is a
    wire-contract risk),
  - `@biomejs/biome` → tilde (a minor bump must not silently change lint/format
    output across the team),
  - everything else → caret (repo default).

`syncpack fix` autofixes any range/consistency drift. Because there is no bun
catalog, a shared dependency's version lives in each consuming unit's
`package.json`; syncpack is what keeps those copies in agreement.

## knip config (per-unit `knip.json`)

Each unit has its own `knip.json` (`tooling/`, `packages/rpc/`,
`services/web-ui-ssr/`), run from that unit's directory. Notable entries:

- `services/web-ui-ssr`: `ignoreExportsUsedInFile: true` — a few exports are
  consumed only within their own module (the e2e fixture base-URL constants, the
  Ark UI toaster singleton); they aren't cross-module imports, so knip's "unused
  export" report is a false positive.
- `tooling`: `tooling/eslint/ci.ts` is an entry — that config is loaded via
  `eslint --config …` (the `nix run .#ci-eslint` app), never imported, so knip
  can't infer it is reachable. `@bufbuild/protoc-gen-es` /
  `@connectrpc/protoc-gen-connect-query` are ignored deps (buf `local:` protoc
  plugins in `buf.gen.yaml`, not importable JS); `solid-refresh` is the Solid HMR
  babel transform injected by `@rsbuild/plugin-solid` and referenced only by
  string in `rsbuild.config.ts`.
- `packages/rpc`: `ignoreDependencies: ["@bufbuild/protobuf"]` — that package is
  nothing but buf-generated code under `gen/` (gitignored, so knip can't scan it);
  the generated `todo_pb.ts` imports `@bufbuild/protobuf`, a real dependency
  invisible to knip only because the code is generated.
