import { readFileSync } from "node:fs";
import type { Context } from "hono";
import { Hono } from "hono";
import type { RenderResult } from "./entry-server";

const isDev = process.env.NODE_ENV === "development";
const DEFAULT_PORT = 3000;
const port = Number(process.env.PORT) || DEFAULT_PORT;

type RenderFn = (url: string) => Promise<RenderResult>;

const app = new Hono();

let getRender: () => Promise<RenderFn>;
let getTemplateParts: () => [string, string] | Promise<[string, string]>;
let preloadHtml = "";

if (isDev) {
	// ── DEV MODE ────────────────────────────────────────────────────────
	// Stripped entirely in the production build: Rsbuild replaces
	// process.env.NODE_ENV with "production", so the condition becomes
	// if (false) and the minifier removes this branch along with all
	// dynamic imports (@rsbuild/core, @hono/node-server).

	const { createRsbuild, loadConfig } = await import(/* webpackIgnore: true */ "@rsbuild/core");
	const { createServer } = await import(/* webpackIgnore: true */ "node:http");
	const { getRequestListener } = await import(/* webpackIgnore: true */ "@hono/node-server");

	const { content: rsbuildConfig } = await loadConfig({});
	const rsbuild = await createRsbuild({ rsbuildConfig });
	const rsbuildServer = await rsbuild.createDevServer();

	// Invalidate cached render function when SSR bundle recompiles
	let cachedRender: RenderFn | null = null;
	rsbuild.onAfterDevCompile(() => {
		cachedRender = null;
	});

	getRender = async () => {
		if (!cachedRender) {
			const mod = await rsbuildServer.environments.ssr.loadBundle<{
				render: RenderFn;
			}>("index");
			cachedRender = mod.render;
		}
		return cachedRender;
	};

	// Rsbuild injects dev scripts into the template automatically;
	// split per-request because the template changes on HMR rebuilds
	getTemplateParts = async () => {
		const tpl = await rsbuildServer.environments.web.getTransformedHtml("index");
		return tpl.split("<!--ssr-outlet-->") as [string, string];
	};

	app.get("*", handleSsr);

	// Bridge: Rsbuild middleware handles static assets + HMR WebSocket;
	// everything else falls through to Hono's SSR handler.
	const honoListener = getRequestListener(app.fetch);
	const server = createServer((req, res) => {
		rsbuildServer.middlewares(req, res, () => honoListener(req, res));
	});
	rsbuildServer.connectWebSocket({ server });
	server.listen(port, () => {
		// biome-ignore lint/suspicious/noConsole: startup log
		console.log(`web-ui-ssr dev server on http://localhost:${port}`);
	});
} else {
	// ── PRODUCTION MODE ─────────────────────────────────────────────────
	const { render } = await import(/* webpackMode: "eager" */ "./entry-server");
	const { serveStatic } = await import("hono/bun");

	getRender = async () => render;

	// We call the loadTemplate function and split it early to avoid
	// repeated calling of these function on each request by caching
	const parts = loadTemplate().split("<!--ssr-outlet-->") as [string, string];
	getTemplateParts = () => parts;
	preloadHtml = buildPreloadHtml();

	app.use("/static/*", serveStatic({ root: "dist/web" }));
	app.get("*", handleSsr);

	// biome-ignore lint/suspicious/noConsole: startup log
	console.log(`web-ui-ssr listening on http://localhost:${port}`);
}

// ── Shared SSR handler ──────────────────────────────────────────────────

async function handleSsr(c: Context): Promise<Response> {
	const url = c.req.url;
	const render = await getRender();
	const [templateHead, templateTail] = await getTemplateParts();
	const { readable: appStream, headTags, hydrationScript, dehydratedState } = await render(url);

	const encoder = new TextEncoder();
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();

	void (async () => {
		try {
			// Wait for the shell to complete so @solidjs/meta tags are available
			const metaTags = await headTags;

			const headWithAssets = templateHead.replace(
				"</head>",
				`${hydrationScript}\n${preloadHtml}\n${metaTags}\n</head>`,
			);
			await writer.write(encoder.encode(headWithAssets));

			const reader = appStream.getReader();
			for (;;) {
				// biome-ignore lint/performance/noAwaitInLoops: stream reading is sequential
				const { done, value } = await reader.read();
				if (done) break;
				await writer.write(value);
			}

			// Inject dehydrated TanStack Query state before closing body
			const stateScript = `<script id="__QUERY_STATE__" type="application/json">${escapeScriptContent(dehydratedState)}</script>`;
			const tail = templateTail.replace("</body>", `${stateScript}\n</body>`);
			await writer.write(encoder.encode(tail));
			await writer.close();
		} catch (error) {
			await writer.abort(error);
		}
	})();

	return new Response(readable, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

// ── Production helpers ──────────────────────────────────────────────────

/** Escape a string for safe use inside an HTML attribute value. */
function escapeAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Escape JSON content for safe embedding inside a <script> tag. */
function escapeScriptContent(s: string): string {
	return s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

interface ManifestAssets {
	initial: { js: string[]; css?: string[] };
	async: { js?: string[]; css?: string[] };
}

interface RawManifest {
	entries?: {
		index?: Partial<ManifestAssets>;
	};
}

function loadTemplate(): string {
	try {
		return readFileSync("dist/web/index.html", "utf-8");
	} catch {
		return '<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>';
	}
}

function buildPreloadHtml(): string {
	const empty: ManifestAssets = { initial: { js: [] }, async: {} };
	let manifest: ManifestAssets;
	try {
		const raw = JSON.parse(readFileSync("dist/web/manifest.json", "utf-8")) as RawManifest;
		const entry = raw.entries?.index;
		manifest = entry ? { initial: entry.initial ?? { js: [] }, async: entry.async ?? {} } : empty;
	} catch {
		manifest = empty;
	}

	const tags: string[] = [];
	for (const js of manifest.initial.js) {
		tags.push(`<link rel="modulepreload" href="${escapeAttr(js)}">`);
	}
	for (const css of manifest.initial.css ?? []) {
		tags.push(`<link rel="stylesheet" href="${escapeAttr(css)}">`);
	}
	for (const js of manifest.async.js ?? []) {
		tags.push(`<link rel="prefetch" as="script" href="${escapeAttr(js)}">`);
	}
	for (const css of manifest.async.css ?? []) {
		tags.push(`<link rel="stylesheet" href="${escapeAttr(css)}">`);
	}
	return tags.join("\n");
}

// Bun picks up this default export to start its HTTP server.
// In dev mode (Node), undefined prevents accidental dual server binding.
// In prod, dead-code elimination reduces isDev to false, keeping the export.
export default isDev ? undefined : { port, fetch: app.fetch };
