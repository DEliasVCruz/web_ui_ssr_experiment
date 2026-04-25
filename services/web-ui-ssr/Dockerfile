FROM oven/bun:1.3.13 AS base
WORKDIR /app

# Install dependencies with bun
FROM base AS deps
COPY package.json bun.lock ./
COPY packages/rpc/package.json packages/rpc/
COPY services/business-logic/package.json services/business-logic/
COPY services/web-ui-ssr/package.json services/web-ui-ssr/
RUN bun install

# Build the client and server bundles with Rsbuild
# Use Node for the build step — vanilla-extract's vm.runInNewContext
# doesn't work under Bun on Linux (tested through Bun 1.3.13)
FROM node:22-slim AS build
WORKDIR /app
ARG PUBLIC_BUSINESS_LOGIC_URL=http://localhost:3001
ENV PUBLIC_BUSINESS_LOGIC_URL=$PUBLIC_BUSINESS_LOGIC_URL
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/rpc/node_modules packages/rpc/node_modules
COPY --from=deps /app/services/web-ui-ssr/node_modules services/web-ui-ssr/node_modules
COPY packages/rpc packages/rpc
COPY services/web-ui-ssr services/web-ui-ssr
COPY tsconfig.json ./
WORKDIR /app/services/web-ui-ssr
RUN npx rsbuild build
WORKDIR /app

# Production image — bun runtime
FROM base AS runtime
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/rpc/node_modules packages/rpc/node_modules
COPY --from=deps /app/services/web-ui-ssr/node_modules services/web-ui-ssr/node_modules
COPY packages/rpc packages/rpc
COPY services/web-ui-ssr/package.json services/web-ui-ssr/
COPY --from=build /app/services/web-ui-ssr/dist services/web-ui-ssr/dist

WORKDIR /app/services/web-ui-ssr
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "dist/server/index.js"]
