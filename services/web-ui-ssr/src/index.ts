import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { render } from "./entry-server";

const app = new Hono();

type ManifestEntry =
	| { fileType: "js"; file: string }
	| { fileType: "css"; css: string[] }
	| { fileType: "other"; file: string };

// Read the manifest and classify each entry by file type
function loadManifest(): ManifestEntry[] {
	let raw: Record<string, { file: string; css?: string[] }>;
	try {
		raw = JSON.parse(readFileSync("dist/web/manifest.json", "utf-8"));
	} catch {
		return [];
	}

	return Object.values(raw).map((entry) => {
		if (entry.file?.endsWith(".js")) {
			return { fileType: "js", file: entry.file };
		}
		if (entry.css) {
			return { fileType: "css", css: entry.css };
		}
		return { fileType: "other", file: entry.file };
	});
}

// Read the HTML template produced by Rsbuild
function loadTemplate(): string {
	try {
		return readFileSync("dist/web/index.html", "utf-8");
	} catch {
		return '<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>';
	}
}

// Cache static build artifacts at startup
const manifest = loadManifest();
const template = loadTemplate();

// Serve static assets from the client build output
app.use("/static/*", serveStatic({ root: "dist/web" }));

// SSR handler for all other routes
app.get("*", (c) => {
	const url = c.req.url;

	// Collect asset preload tags from the manifest
	const preloadTags: string[] = [];
	manifest.forEach((entry) => {
		switch (entry.fileType) {
			case "js":
				preloadTags.push(`<link rel="modulepreload" href="/static/${entry.file}">`);

				break;
			case "css":
				entry.css.forEach((css) => {
					preloadTags.push(`<link rel="stylesheet" href="/static/${css}">`);
				});

				break;
			default:
				break;
		}
	});

	// Render the SolidJS app to a readable stream
	const appStream = render(url);

	// Split template at the SSR outlet marker
	const [head, tail] = template.split("<!--ssr-outlet-->");

	// Inject preload tags before </head>
	const headWithAssets = head.replace("</head>", `${preloadTags.join("\n")}\n</head>`);

	// Build the response stream: head + app stream + tail
	const encoder = new TextEncoder();
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();

	(async () => {
		try {
			await writer.write(encoder.encode(headWithAssets));

			const reader = appStream.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				await writer.write(value);
			}

			await writer.write(encoder.encode(tail));
			await writer.close();
		} catch (error) {
			await writer.abort(error);
		}
	})();

	return new Response(readable, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
});

const DEFAULT_PORT = 3000;
const port = Number(process.env.PORT) || DEFAULT_PORT;

export default {
	port,
	fetch: app.fetch,
};

// biome-ignore lint/suspicious/noConsole: intentional startup log
console.log(`web-ui-ssr listening on http://localhost:${port}`);
