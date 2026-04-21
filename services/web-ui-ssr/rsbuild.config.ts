import { defineConfig } from "@rsbuild/core";
import { pluginSolid } from "@rsbuild/plugin-solid";
import { VanillaExtractPlugin } from "@vanilla-extract/webpack-plugin";

const PUBLIC_BUSINESS_LOGIC_URL = process.env.PUBLIC_BUSINESS_LOGIC_URL ?? "http://localhost:3001";

export default defineConfig({
	plugins: [pluginSolid()],

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
				},
			},
			html: {
				template: "./src/template.html",
			},
		},

		node: {
			source: {
				entry: { index: "./src/entry-server.tsx" },
			},
			output: {
				target: "node",
				distPath: { root: "dist/server" },
				emitCss: false,
			},
		},
	},
});
