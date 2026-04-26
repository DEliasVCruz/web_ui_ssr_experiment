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

	// Invalidate cached render function when SSR bundle recompiles.
	let cachedRender: RenderFn | null = null;
	rsbuild.onAfterDevCompile(() => {
		cachedRender = null;
	});

	const rsbuildServer = await rsbuild.createDevServer();

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

	// Bridge: Rsbuild middleware handles static assets, HMR, lazy compilation,
	// etc. For the root path Rsbuild would serve its compiled index.html, so
	// we route it directly to Hono's SSR handler. All other paths try Rsbuild
	// first and fall through to Hono for SSR on miss.
	const honoListener = getRequestListener(app.fetch);
	const server = createServer((req, res) => {
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		if (pathname === "/" || pathname === "/index.html") {
			honoListener(req, res);
		} else {
			rsbuildServer.middlewares(req, res, () => honoListener(req, res));
		}
	});
	rsbuildServer.connectWebSocket({ server });
	server.listen(port, async () => {
		await rsbuildServer.afterListen();
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

	app.use("/static/*", serveStatic({ root: "dist/web" }));
	app.get("*", handleSsr);

	// Use Bun.serve() explicitly — the `export default { port, fetch }`
	// pattern doesn't survive rspack's async-module wrapping, so Bun
	// can't detect it and the process exits immediately.
	Bun.serve({ port, fetch: app.fetch });
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
				`${hydrationScript}\n${metaTags}\n</head>`,
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

/** Escape JSON content for safe embedding inside a <script> tag. */
function escapeScriptContent(s: string): string {
	return s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function loadTemplate(): string {
	try {
		return readFileSync("dist/web/index.html", "utf-8");
	} catch {
		return '<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>';
	}
}
