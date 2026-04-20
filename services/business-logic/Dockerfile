FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
COPY packages/rpc/package.json packages/rpc/
COPY services/business-logic/package.json services/business-logic/
RUN bun install --frozen-lockfile

# Production image
FROM base AS runtime
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/rpc/node_modules packages/rpc/node_modules
COPY --from=deps /app/services/business-logic/node_modules services/business-logic/node_modules
COPY packages/rpc packages/rpc
COPY services/business-logic/src services/business-logic/src
COPY services/business-logic/package.json services/business-logic/
COPY services/business-logic/tsconfig.json services/business-logic/

WORKDIR /app/services/business-logic
ENV PORT=3001
EXPOSE 3001
CMD ["bun", "run", "src/index.ts"]
