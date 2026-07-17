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
│       ├── src/             # Source code (Maven layout)
│       ├── pom.xml          # Maven build
│       └── package.json     # TS-side contract-test workspace
├── package.json             # Root with workspaces
├── tsconfig.json            # Shared TypeScript config
└── docker-compose.yml       # Service orchestration
```

## Quick Start

```bash
# Install dependencies
bun install

# Run all services in development
bun run dev

# Build all services
bun run build
```

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
`bun run lint:hygiene` or `devenv tasks run ci:hygiene`.
