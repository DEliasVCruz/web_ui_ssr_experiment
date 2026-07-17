import path from "node:path";
import type { RsbuildPlugin } from "@rsbuild/core";
import { defineConfig } from "@rsbuild/core";
import { modifyBabelLoaderOptions, pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";
import { InjectManifest } from "@serwist/webpack-plugin";
import { tanstackRouter } from "@tanstack/router-plugin/rspack";

const PUBLIC_BUSINESS_LOGIC_URL = process.env.PUBLIC_BUSINESS_LOGIC_URL ?? "http://localhost:3001";
const isDev = process.env.NODE_ENV !== "production";

// Revision for the precached /offline shell (see the InjectManifest wiring below).
// Evaluated once per build; a per-build value guarantees the shell — which embeds
// the build's content-hashed <script>/<link> URLs — is refetched on every redeploy.
const SW_BUILD_REVISION = String(Date.now());

/**
 * Strips the solid-refresh/babel plugin that pluginSolid injects for HMR
 * in the web environment. solid-refresh wraps components in HMR proxies,
 * changing the component tree depth. Since the SSR environment doesn't get
 * these wrappers (pluginSolid only adds them for target "web"), hydration
 * keys diverge and hydrate() fails. Removing solid-refresh from the client
 * aligns both trees. Regular module HMR still works; only per-component
 * hot-swap is lost.
 */
function pluginStripSolidRefresh(): RsbuildPlugin {
	return {
		name: "strip-solid-refresh",
		setup(api) {
			api.modifyBundlerChain((chain, { CHAIN_ID }) => {
				modifyBabelLoaderOptions({
					chain,
					// biome-ignore lint/style/useNamingConvention: must match Rsbuild's API key
					CHAIN_ID,
					modifier: (babelOptions) => {
						babelOptions.plugins = (babelOptions.plugins ?? []).filter(
							(p: unknown) => !String(Array.isArray(p) ? p[0] : p).includes("solid-refresh"),
						);
						return babelOptions;
					},
				});
			});
		},
	};
}

// Shared SSR compilation config used by both dev (ssr) and prod (server) environments
const ssrShared = {
	plugins: [pluginSolid({ solidPresetOptions: { generate: "ssr", hydratable: true } })],
	source: {
		define: {
			// biome-ignore lint/style/useNamingConvention: must match the global identifier
			PUBLIC_BUSINESS_LOGIC_URL: JSON.stringify("http://placeholder"),
		},
	},
	output: {
		target: "node" as const,
		distPath: { root: "dist/server" },
		emitCss: false,
	},
	resolve: {
		conditionNames: ["solid", "node", "import", "module", "default"],
	},
};

export default defineConfig({
	plugins: [pluginBabel({ include: /\.(?:jsx|tsx)$/ })],

	tools: {
		// Function form so the service-worker InjectManifest plugin can be scoped to
		// the CLIENT (web) environment in PRODUCTION only: the server/ssr build
		// (target node) must never carry SW code, and dev uses rsbuild HMR (a SW
		// would fight it). tanstackRouter stays on every environment as before.
		rspack: (_config, { environment, appendPlugins }) => {
			appendPlugins(tanstackRouter({ target: "solid", autoCodeSplitting: true }));
			if (!isDev && environment.name === "web") {
				appendPlugins(
					// InjectManifest compiles src/sw.ts and injects self.__SW_MANIFEST with
					// this build's content-hashed precache list, emitting dist/web/sw.js
					// (served at /sw.js, root scope, by index.ts). Same build as the
					// manifest.json the SSR head reads → the hashed URLs the head preloads
					// are exactly the precached URLs, so they resolve from precache offline.
					new InjectManifest({
						swSrc: path.resolve(import.meta.dirname, "src/sw.ts"),
						swDest: "sw.js",
						// The offline-shell document (/offline) is served by the prod server
						// and precached so never-visited routes get a client-render fallback
						// offline. A per-build revision busts it when asset hashes change.
						additionalPrecacheEntries: [{ url: "/offline", revision: SW_BUILD_REVISION }],
						// Don't precache source maps, the rsbuild asset manifest, or license
						// text — none are servable precache assets.
						exclude: [/\.map$/, /^manifest\.json$/, /\.LICENSE\.txt$/],
					}),
				);
			}
		},
		// The root route (routes/__root.tsx) renders the full HTML document, so
		// Rsbuild must not generate an HTML template. CSS/script URLs are read
		// from the compilation stats (dev) / manifest.json (prod) and injected
		// through the router context into the root route's head().
		htmlPlugin: false,
	},

	// Disable lazy compilation so all route CSS is compiled upfront,
	// preventing FOUC during SSR.
	dev: {
		lazyCompilation: false,
	},

	environments: {
		web: {
			plugins: [
				pluginSolid({ solidPresetOptions: { hydratable: true } }),
				...(isDev ? [pluginStripSolidRefresh()] : []),
			],
			source: {
				entry: { index: "./src/entry-client.tsx" },
				define: {
					// biome-ignore lint/style/useNamingConvention: key must match the global identifier replaced at compile time
					PUBLIC_BUSINESS_LOGIC_URL: JSON.stringify(PUBLIC_BUSINESS_LOGIC_URL),
				},
			},
			output: {
				target: "web",
				manifest: true,
				distPath: { root: "dist/web" },
			},
			resolve: {
				conditionNames: ["solid", "browser", "import", "module", "default"],
			},
			splitChunks: {
				preset: "none",
				cacheGroups: {
					"vendor-solid": {
						test: /node_modules[\\/]solid-js/,
						name: "vendor-solid",
						chunks: "all",
						enforce: true,
					},
					"vendor-router": {
						test: /node_modules[\\/]@tanstack[\\/]solid-router/,
						name: "vendor-router",
						chunks: "all",
						enforce: true,
					},
				},
			},
		},

		// Dev mode: SSR entry compiled separately, loaded via loadBundle() at runtime
		// Prod mode: full Hono server as entry — bundles entry-server.tsx, dev code
		// stripped via dead-code elimination
		...(isDev
			? {
					ssr: {
						...ssrShared,
						source: {
							...ssrShared.source,
							entry: { index: "./src/entry-server.tsx" },
						},
					},
				}
			: {
					server: {
						...ssrShared,
						source: {
							...ssrShared.source,
							entry: { index: "./src/index.ts" },
						},
					},
				}),
	},
});
