import { defineConfig } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";
import { VanillaExtractPlugin } from "@vanilla-extract/webpack-plugin";

const PUBLIC_BUSINESS_LOGIC_URL = process.env.PUBLIC_BUSINESS_LOGIC_URL ?? "http://localhost:3001";
const isDev = process.env.NODE_ENV !== "production";

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
		rspack: {
			plugins: [new VanillaExtractPlugin()],
		},
	},

	environments: {
		web: {
			plugins: [pluginSolid({ solidPresetOptions: { hydratable: true } })],
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
			performance: {
				chunkSplit: {
					strategy: "custom",
					forceSplitting: {
						"vendor-solid": /node_modules[\\/]solid-js/,
						"vendor-router": /node_modules[\\/]@solidjs[\\/]router/,
					},
					override: {
						cacheGroups: {
							// Dev-only: pin vanilla-extract virtual modules to a stable chunk
							// name so splitChunks doesn't reorganize chunk boundaries on HMR,
							// which causes "undefined factory" errors (rsbuild#6049).
							...(process.env.NODE_ENV === "development" && {
								vanillaCss: {
									minSize: 0,
									test: /@vanilla-extract\/webpack-plugin/,
									priority: 1000,
									name: "vanilla-extract",
								},
							}),
						},
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
