import { defineConfig } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";
import { VanillaExtractPlugin } from "@vanilla-extract/webpack-plugin";

const PUBLIC_BUSINESS_LOGIC_URL = process.env.PUBLIC_BUSINESS_LOGIC_URL ?? "http://localhost:3001";

export default defineConfig({
	plugins: [
		pluginBabel({ include: /\.(?:jsx|tsx)$/ }),
		pluginSolid({ solidPresetOptions: { hydratable: true } }),
	],

	tools: {
		rspack: {
			plugins: [new VanillaExtractPlugin()],
		},
	},

	environments: {
		web: {
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

		node: {
			plugins: [
				// SSR environment: compile Solid JSX with generate:"ssr"
				pluginSolid({ solidPresetOptions: { generate: "ssr", hydratable: true } }),
			],
			source: {
				entry: { index: "./src/entry-server.tsx" },
				define: {
					// The client transport is imported by shared page components;
					// on the server this value is unused but must be defined to
					// avoid a ReferenceError when the module is loaded.
					// biome-ignore lint/style/useNamingConvention: must match the global identifier
					PUBLIC_BUSINESS_LOGIC_URL: JSON.stringify("http://placeholder"),
				},
			},
			output: {
				target: "node",
				distPath: { root: "dist/server" },
				emitCss: false,
			},
			// Resolve @solidjs/* packages to their JSX source so
			// babel-preset-solid can compile them for SSR.
			resolve: {
				conditionNames: ["solid", "node", "import", "module", "default"],
			},
		},
	},
});
