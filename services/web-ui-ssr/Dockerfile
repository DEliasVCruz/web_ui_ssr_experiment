FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
COPY packages/rpc/package.json packages/rpc/
COPY services/web-ui-ssr/package.json services/web-ui-ssr/
RUN bun install --frozen-lockfile

# Build the client and server bundles with Rsbuild
FROM deps AS build
ARG PUBLIC_BUSINESS_LOGIC_URL=http://localhost:3001
ENV PUBLIC_BUSINESS_LOGIC_URL=$PUBLIC_BUSINESS_LOGIC_URL
COPY packages/rpc packages/rpc
COPY services/web-ui-ssr services/web-ui-ssr
COPY tsconfig.json ./
WORKDIR /app/services/web-ui-ssr
RUN bun run build
WORKDIR /app

# Production image
FROM base AS runtime
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/rpc/node_modules packages/rpc/node_modules
COPY --from=deps /app/services/web-ui-ssr/node_modules services/web-ui-ssr/node_modules
COPY packages/rpc packages/rpc
COPY services/web-ui-ssr/src services/web-ui-ssr/src
COPY services/web-ui-ssr/package.json services/web-ui-ssr/
COPY services/web-ui-ssr/tsconfig.json services/web-ui-ssr/
COPY --from=build /app/services/web-ui-ssr/dist services/web-ui-ssr/dist

WORKDIR /app/services/web-ui-ssr
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
