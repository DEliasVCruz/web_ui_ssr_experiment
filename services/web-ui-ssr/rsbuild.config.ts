import type { RsbuildPlugin } from "@rsbuild/core";
import { defineConfig } from "@rsbuild/core";
import { modifyBabelLoaderOptions, pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";

const PUBLIC_BUSINESS_LOGIC_URL = process.env.PUBLIC_BUSINESS_LOGIC_URL ?? "http://localhost:3001";
const isDev = process.env.NODE_ENV !== "production";

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
			performance: {
				chunkSplit: {
					strategy: "custom",
					forceSplitting: {
						"vendor-solid": /node_modules[\\/]solid-js/,
						"vendor-router": /node_modules[\\/]@solidjs[\\/]router/,
					},
				},
			},
			html: {
				template: "./src/template.html",
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
