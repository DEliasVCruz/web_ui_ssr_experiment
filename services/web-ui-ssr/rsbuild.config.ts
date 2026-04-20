import { defineConfig } from "@rsbuild/core";
import { pluginSolid } from "@rsbuild/plugin-solid";
import { VanillaExtractPlugin } from "@vanilla-extract/webpack-plugin";

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
