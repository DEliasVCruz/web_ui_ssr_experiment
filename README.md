# Web UI SSR POC

Proof-of-concept for the web UI SSR layer of a larger platform.

## Directory Structure

```
.
├── services/
│   ├── web-ui-ssr/          # Bun + Hono rendering server
│   │   ├── src/             # Source code
│   │   ├── package.json     # Service dependencies
│   │   └── tsconfig.json    # TypeScript config
│   └── business-logic-java/ # Java (Helidon SE) backend
│       ├── src/             # Source code (Maven layout; *IT integration tests)
│       └── pom.xml          # Standalone Maven build (no reactor; consumes packages/java/*)
├── package.json             # Root with workspaces
├── tsconfig.json            # Shared TypeScript config
└── docker-compose.yml       # Service orchestration
```

## Quick Start

Nix is the only entry point. `nix develop` gives you the dev shell (it also
bootstraps a fresh clone: per-unit `bun install`, panda codegen, git hooks,
podman/DOCKER_HOST wiring), and `nix run .#<app>` runs every workflow.

```bash
# Enter the dev shell (fully provisions a fresh clone on first entry)
nix develop

# Regenerate code from protobuf (buf + JSON Schema + panda)
nix run .#generate

# Run the web-ui-ssr dev server (start the backend separately: nix run .#up)
nix run .#dev

# Bring the whole local stack up (postgres + backend + web) via podman compose
nix run .#up
```

Run `nix run .#` and press Tab, or see [`nix/README.md`](nix/README.md), for the
full app set (lint, typecheck, Java build/verify, E2E, …).

## Services

### web-ui-ssr
- Runtime: Bun
- Framework: Hono + SolidJS SSR
- Purpose: HTML rendering and client bundle serving

### business-logic-java
- Runtime: JVM (JDK 25)
- Framework: Helidon SE (+ in-repo Connect-unary adapter)
- Purpose: Backend stub with PostgreSQL, serving the same Connect RPC contract
  the connect-es clients speak (see `services/business-logic-java/README.md`)

## Development

This is a learning exercise and not production code. See `AGENTS.md` for detailed guidance.

The local container runtime (for `docker-compose.yml` and Testcontainers) is
**podman** — see [`docs/podman.md`](docs/podman.md) for one-time machine setup,
the env wiring, and the Ryuk decision.

Dependency-version consistency, shared version catalog, and unused-code lints
(syncpack + bun catalog + sherif + knip) are described in
[`docs/workspace-hygiene.md`](docs/workspace-hygiene.md) — run them with
`bun run lint:hygiene` or `nix run .#ci-hygiene`.
