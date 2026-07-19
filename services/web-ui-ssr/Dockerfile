FROM oven/bun:1.3.13 AS base
WORKDIR /app

# De-workspaced (5ae): no root package.json / bun workspace. web-ui-ssr is
# self-contained with its own bun.lock and a file: dependency on packages/rpc.
# The build context is the repo root (so packages/rpc/gen — buf-generated,
# gitignored — must be present locally, same as before). --ignore-scripts skips
# the postinstall step; each stage instead COPIES the @web-ui-poc/rpc package
# (package.json + gen/) into node_modules as a REAL directory — mirroring the nix
# injectRpc. A symlink would break: rpc's gen imports @bufbuild/protobuf, and a
# symlinked package resolves from its realpath (/app/packages/rpc, whose
# node_modules is dockerignored and where no root node_modules exists). A real
# dir resolves @bufbuild/protobuf by walking up into the service's own hoisted
# node_modules.
#
# NOTE: `bun install --frozen-lockfile` accepts a STALE embedded file:-dep
# manifest silently. After editing packages/rpc/package.json, run plain
# `bun install` in services/web-ui-ssr and commit the refreshed bun.lock.

# Install dependencies with bun
FROM base AS deps
COPY packages/rpc/package.json packages/rpc/
COPY services/web-ui-ssr/package.json services/web-ui-ssr/bun.lock services/web-ui-ssr/
WORKDIR /app/services/web-ui-ssr
RUN bun install --frozen-lockfile --ignore-scripts
WORKDIR /app

# Build the client and server bundles with Rsbuild
FROM base AS build
ARG PUBLIC_BUSINESS_LOGIC_URL=http://localhost:3001
ENV PUBLIC_BUSINESS_LOGIC_URL=$PUBLIC_BUSINESS_LOGIC_URL
COPY --from=deps /app/services/web-ui-ssr/node_modules services/web-ui-ssr/node_modules
COPY packages/rpc packages/rpc
COPY services/web-ui-ssr services/web-ui-ssr
COPY tsconfig.json ./
# Inject @web-ui-poc/rpc as a REAL dir (package.json + gen/), not a symlink.
RUN rm -rf services/web-ui-ssr/node_modules/@web-ui-poc/rpc \
    && mkdir -p services/web-ui-ssr/node_modules/@web-ui-poc/rpc \
    && cp packages/rpc/package.json services/web-ui-ssr/node_modules/@web-ui-poc/rpc/ \
    && cp -R packages/rpc/gen services/web-ui-ssr/node_modules/@web-ui-poc/rpc/gen
WORKDIR /app/services/web-ui-ssr
RUN bunx panda codegen --clean && NODE_ENV=production bunx rsbuild build
WORKDIR /app

# Production image — bun runtime
FROM base AS runtime
COPY --from=deps /app/services/web-ui-ssr/node_modules services/web-ui-ssr/node_modules
COPY packages/rpc packages/rpc
COPY services/web-ui-ssr/package.json services/web-ui-ssr/
COPY --from=build /app/services/web-ui-ssr/dist services/web-ui-ssr/dist
RUN rm -rf services/web-ui-ssr/node_modules/@web-ui-poc/rpc \
    && mkdir -p services/web-ui-ssr/node_modules/@web-ui-poc/rpc \
    && cp packages/rpc/package.json services/web-ui-ssr/node_modules/@web-ui-poc/rpc/ \
    && cp -R packages/rpc/gen services/web-ui-ssr/node_modules/@web-ui-poc/rpc/gen

WORKDIR /app/services/web-ui-ssr
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "dist/server/index.js"]
