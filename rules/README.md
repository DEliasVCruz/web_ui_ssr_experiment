# ast-grep rules

Cross-language ([ast-grep](https://ast-grep.github.io/)) structural rules that turn
the machine-checkable **working agreements** in [`AGENTS.md`](../AGENTS.md) into a
hard gate over **TypeScript and Java**. Configuration lives in
[`sgconfig.yml`](../sgconfig.yml) (`ruleDirs: [rules]`).

## Why these rules exist (and why not others)

ast-grep only owns agreements that the *existing* guardrails leave uncovered. It
deliberately does **not** duplicate:

| Concern | Already enforced by | So ast-grep stays out |
| --- | --- | --- |
| Java package layering / domain purity / JDBC confinement / adapter service-agnosticism | **ArchUnit** (`ArchitectureTest.java` in both Java modules) | yes |
| Raw styling values (colors, spacing) | **Panda `strictTokens`** + `eslint-plugin-panda` | yes |
| Type discipline, `process.env` dot/bracket access | **strict `tsconfig`** (`noPropertyAccessFromIndexSignature`) + **biome** (`useLiteralKeys`) | yes |
| Proto wire-contract drift | **`buf breaking`** (`ci:proto-breaking` task) | yes |

Prose-only agreements ("Read Basic Memory first", "Match the notes", "Prefer small,
reversible changes", "Record learnings") are not structurally expressible and are
not encoded. "Streaming requires Suspense" is a runtime/semantic property, not a
reliable syntactic pattern, so it is left to review.

## Rules

Each logical rule below ships as one YAML file, with a separate document per
ast-grep language (`typescript` for `.ts`, `tsx` for `.tsx`, `java`) — ast-grep
parses `.ts` and `.tsx` with different grammars, so a rule that must cover both
declares both. Rule ids carry a `-ts` / `-tsx` / `-java` suffix.

| Rule (file) | Agreement enforced (quoted from AGENTS.md) | Rationale | Example violation |
| --- | --- | --- | --- |
| **connect-transport-centralized** <br> `connect-transport-centralized.yml` <br> (`-ts`, `-tsx`) | *"Same RPC contract on both sides. Both SSR code and browser code should import the same generated connect-es client and call the same methods."* (Working agreements) — plus the landed decision (commit `02e5777`, "unify on fetch-based connect-web transport") that the transport is built in exactly two modules. | `createConnectTransport()` may be called **only** in `src/transport.ts` (SSR) and `src/transport-client.ts` (browser); every other module receives a `Transport` by parameter / router context. Stops ad-hoc clients drifting from the shared binary + `useHttpGet` config. Not covered by tsconfig/biome/ArchUnit. | A route or query module calls `createConnectTransport({ baseUrl })` inline instead of taking the injected `Transport`. |
| **renderer-owns-no-data** <br> `renderer-owns-no-data.yml` <br> (`-ts`, `-tsx`) | *"Keep the two services honest. The rendering server must not own data or proxy post-hydration traffic. The business-logic server must be the only SQLite client."* (Working agreements) | The web-ui-ssr renderer owns no persistence; importing a SQLite driver (`bun:sqlite`, `node:sqlite`, `better-sqlite3`, `sqlite3`) is the structural signal that it has started owning data. ArchUnit enforces SQLite confinement *inside* the Java service but cannot see the TS renderer — this closes the cross-service gap. | `import { Database } from "bun:sqlite"` inside `services/web-ui-ssr/src`. |
| **no-realtime-websockets** <br> `no-realtime-websockets.yml` <br> (`-ts`, `-tsx`, `-java`) | *"WebSockets / realtime transport"* listed under **"Out of scope (do not add)"**; *"If you find yourself reaching for one of these to make something work, stop and flag it."* | Turns "stop and flag it" into a gate in both languages: TS (`new WebSocket`, `new WebSocketServer`, importing `ws`) and Java (importing `jakarta.websocket` / Helidon WebSocket support). No other guardrail bans realtime transport. | `new WebSocket("ws://…")` in the client; `import jakarta.websocket.Session;` in the backend. |
| **no-jwt-auth** <br> `no-jwt-auth.yml` <br> (`-ts`, `-tsx`, `-java`) | *"Real authentication / JWT middleware"* listed under **"Out of scope (do not add)"**. | Bans importing a JWT/auth library in both languages: TS (`jsonwebtoken`, `jose`) and Java (`io.jsonwebtoken`, `com.auth0.jwt`, `com.nimbusds`). Scope discipline the ast-grep engine expresses once across both stacks. | `import jwt from "jsonwebtoken"` in the renderer; `import io.jsonwebtoken.Jwts;` in the backend. |

## Scope & generated-code immunity

Every rule pins `files:` to the **hand-written source roots**
(`services/web-ui-ssr/src/**`, `services/business-logic-java/src/main/java/**`,
`packages/java/*/src/main/java/**`). Generated and build output is therefore never
scanned, by two independent mechanisms:

1. ast-grep's file discovery honours `.gitignore`, and every generated tree
   (`packages/rpc/gen`, `services/business-logic-java/generated-sources`, `target/`,
   `dist/`, `node_modules/`, `styled-system/`) is gitignored.
2. The per-rule `files:` allowlist means a generated file outside those source roots
   can never match a rule **even if it is present on disk and un-ignored**.

Both were verified: dropping violating snippets into `packages/rpc/gen/` and
`services/business-logic-java/generated-sources/` (gitignored) produced no findings,
and a violating file placed in a non-gitignored path outside the allowlist
(`scripts/`) was likewise not flagged.

`connect-transport-centralized` additionally uses `ignores:` to exempt the two
legitimate transport modules (`src/transport.ts`, `src/transport-client.ts`).

## Running

Standalone (CI gate) — scans the whole repo, exits non-zero on any finding:

```bash
ast-grep scan
```

Automatically as a git hook: `devenv.nix` registers `git-hooks.hooks.ast-grep`
(`entry = "ast-grep scan"`, `pass_filenames = false`, `types_or = [ "ts" "tsx"
"java" ]`). Any commit that touches a TS/TSX/Java file runs a full-repo scan (it is
milliseconds), so a violation cannot slip in through a file that was not itself
staged. Do not bypass the hook.
