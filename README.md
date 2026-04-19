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
│   └── business-logic/      # Bun + Hono backend stub
│       ├── src/             # Source code
│       ├── package.json     # Service dependencies
│       └── tsconfig.json    # TypeScript config
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

### business-logic
- Runtime: Bun
- Framework: Hono
- Purpose: Backend stub with SQLite and connect-es RPC

## Development

This is a learning exercise and not production code. See `AGENTS.md` for detailed guidance.
