import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { render } from "./entry-server";

const app = new Hono();

interface ManifestAssets {
	initial: { js: string[]; css?: string[] };
	async: { js?: string[]; css?: string[] };
}

/** Escape a string for safe use inside an HTML attribute value. */
function escapeAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function loadManifest(): ManifestAssets {
	const empty: ManifestAssets = {
		initial: { js: [] },
		async: {},
	};
	try {
		const raw = JSON.parse(readFileSync("dist/web/manifest.json", "utf-8"));
		const entry = raw.entries?.index;
		if (!entry) return empty;
		return {
			initial: entry.initial ?? { js: [] },
			async: entry.async ?? {},
		};
	} catch {
		return empty;
	}
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

// Collect asset preload tags from the manifest (computed once at startup)
const preloadTags: string[] = [];

// Initial chunks — needed on every page
for (const js of manifest.initial.js) {
	preloadTags.push(`<link rel="modulepreload" href="${escapeAttr(js)}">`);
}
for (const css of manifest.initial.css ?? []) {
	preloadTags.push(`<link rel="stylesheet" href="${escapeAttr(css)}">`);
}

// Async chunks — prefetch so lazy routes load fast
for (const js of manifest.async.js ?? []) {
	preloadTags.push(`<link rel="prefetch" as="script" href="${escapeAttr(js)}">`);
}
for (const css of manifest.async.css ?? []) {
	preloadTags.push(`<link rel="prefetch" as="style" href="${escapeAttr(css)}">`);
}

const preloadHtml = preloadTags.join("\n");

// Split template at the SSR outlet marker (computed once at startup)
const [templateHead, templateTail] = template.split("<!--ssr-outlet-->");

// SSR handler for all other routes
app.get("*", (c) => {
	const url = c.req.url;
	const { readable: appStream, headTags } = render(url);

	const encoder = new TextEncoder();
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();

	(async () => {
		try {
			// Wait for the shell to complete so @solidjs/meta tags are available
			const metaTags = await headTags;

			// Inject manifest preloads and meta tags before </head>
			const headWithAssets = templateHead.replace(
				"</head>",
				`${preloadHtml}\n${metaTags}\n</head>`,
			);

			await writer.write(encoder.encode(headWithAssets));

			const reader = appStream.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				await writer.write(value);
			}

			await writer.write(encoder.encode(templateTail));
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
