import { readFileSync } from "node:fs";
import type { Rspack } from "@rsbuild/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { SsrContext } from "./router";

const isDev = process.env.NODE_ENV === "development";
const DEFAULT_PORT = 3000;
const port = Number(process.env.PORT) || DEFAULT_PORT;

type RenderFn = (request: Request, ssrContext: SsrContext) => Promise<Response>;

const app = new Hono();

let getRender: () => Promise<RenderFn>;
let getSsrContext: () => SsrContext | Promise<SsrContext>;

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

	// Invalidate cached render function when the SSR bundle recompiles and
	// capture the web entry's CSS/JS URLs from the compilation stats so they
	// can be injected into the root route's <head> (FOUC prevention).
	let cachedRender: RenderFn | null = null;
	let ssrContext: SsrContext = { cssUrls: [], scriptUrls: [] };

	rsbuild.onAfterDevCompile(({ stats }) => {
		cachedRender = null;
		ssrContext = extractSsrContextFromStats(stats);
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

	getSsrContext = () => ssrContext;

	app.get("*", handleSsr);

	// Bridge: Rsbuild middleware handles static assets, HMR, lazy compilation,
	// etc. The root path has no compiled HTML file (the root route generates the
	// document), so route it directly to Hono's SSR handler. All other paths try
	// Rsbuild first (static assets) and fall through to Hono for SSR on miss.
	const honoListener = getRequestListener(app.fetch);
	const server = createServer((req, res) => {
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		if (pathname === "/" || pathname === "/index.html") {
			void honoListener(req, res);
		} else {
			rsbuildServer.middlewares(req, res, () => honoListener(req, res));
		}
	});
	rsbuildServer.connectWebSocket({ server });
	server.listen(port, () => {
		void rsbuildServer.afterListen().then(() => {
			// biome-ignore lint/suspicious/noConsole: startup log
			console.log(`web-ui-ssr dev server on http://localhost:${String(port)}`);
		});
	});
} else {
	// ── PRODUCTION MODE ─────────────────────────────────────────────────
	const { render } = await import(/* webpackMode: "eager" */ "./entry-server");
	const { serveStatic } = await import("hono/bun");

	getRender = async () => render;

	// Read hashed CSS/JS URLs from the build manifest once at startup.
	const ssrContext = loadManifestSsrContext();
	getSsrContext = () => ssrContext;

	app.use("/static/*", serveStatic({ root: "dist/web" }));
	app.get("*", handleSsr);

	// Use Bun.serve() explicitly — the `export default { port, fetch }`
	// pattern doesn't survive rspack's async-module wrapping, so Bun
	// can't detect it and the process exits immediately.
	Bun.serve({ port, fetch: app.fetch });
	// biome-ignore lint/suspicious/noConsole: startup log
	console.log(`web-ui-ssr listening on http://localhost:${String(port)}`);
}

// ── Shared SSR handler ──────────────────────────────────────────────────

async function handleSsr(c: Context): Promise<Response> {
	const render = await getRender();
	const ssrContext = await getSsrContext();
	return render(c.req.raw, ssrContext);
}

// ── SSR context helpers ─────────────────────────────────────────────────

/** Extract the web entry's CSS/JS public URLs from a dev-compile MultiStats. */
function extractSsrContextFromStats(
	stats: Rspack.Stats | Rspack.MultiStats | undefined,
): SsrContext {
	const empty: SsrContext = { cssUrls: [], scriptUrls: [] };
	if (!stats) return empty;

	const json = stats.toJson({
		all: false,
		assets: true,
		entrypoints: true,
		children: true,
	});

	const children = json.children ?? [json];
	const web = children.find((child) => child.name === "web") ?? children[0];
	const assets = (web.entrypoints?.index.assets ?? []).map((asset) => asset.name);

	return {
		cssUrls: assets.filter((name) => name.endsWith(".css")).map((name) => `/${name}`),
		scriptUrls: assets.filter((name) => name.endsWith(".js")).map((name) => `/${name}`),
	};
}

/** Read hashed CSS/JS URLs for the client entry from the production manifest. */
function loadManifestSsrContext(): SsrContext {
	try {
		const manifest = JSON.parse(readFileSync("dist/web/manifest.json", "utf-8")) as {
			entries?: Record<string, { initial?: { js?: string[]; css?: string[] } }>;
		};
		const initial = manifest.entries?.index.initial;
		return {
			cssUrls: initial?.css ?? [],
			scriptUrls: initial?.js ?? [],
		};
	} catch {
		return { cssUrls: [], scriptUrls: [] };
	}
}
