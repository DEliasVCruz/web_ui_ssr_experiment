import { readFileSync } from "node:fs";
import type { Rspack } from "@rsbuild/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { createWideEventMiddleware } from "./observability/request-logging";
import { createWideEventLogger } from "./observability/wide-event-logger";
import type { SsrContext } from "./router";

const isDev = process.env.NODE_ENV === "development";
const DEFAULT_PORT = 3000;
// Destructure rather than `process.env.PORT`: dot access is barred by
// noPropertyAccessFromIndexSignature (TS4111) and bracket access by biome's
// useLiteralKeys — destructuring is exempt from both.
const { PORT } = process.env;
const port = Number(PORT) || DEFAULT_PORT;

type RenderFn = (request: Request, ssrContext: SsrContext) => Promise<Response>;

const app = new Hono();

// Emit one wide event per request at the fetch boundary. `instrument` wraps a
// fetch handler so both the prod (Bun.serve) and dev (node http) request paths
// are instrumented coherently; the same handler runs inside per-request
// AsyncLocalStorage so backend RPCs forward the trace context (see transport.ts).
const instrument = createWideEventMiddleware(createWideEventLogger());

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
	let ssrContext: SsrContext = { cssUrls: [], scriptUrls: [], preloadScriptUrls: [] };

	rsbuild.onAfterDevCompile(({ stats }) => {
		cachedRender = null;
		ssrContext = extractSsrContextFromStats(stats);
	});

	const rsbuildServer = await rsbuild.createDevServer();

	getRender = async () => {
		if (!cachedRender) {
			// biome-ignore lint/complexity/useLiteralKeys: `environments` is an index signature; noPropertyAccessFromIndexSignature (TS4111) requires bracket access here.
			const ssrEnv = rsbuildServer.environments["ssr"];
			if (!ssrEnv) throw new Error("rsbuild dev server has no 'ssr' environment");
			const mod = await ssrEnv.loadBundle<{
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
	const honoListener = getRequestListener(instrument((request) => app.fetch(request)));
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

	// Long-lived immutable caching for the content-hashed build assets (mid-deploy
	// stale-tab mitigation, 1w9.2 F5 — low-risk half only, no reload-on-controllerchange).
	// Everything Rsbuild emits under /static carries a [contenthash] in its filename, so a
	// given URL's bytes never change: cache it for a year and mark it `immutable` so the
	// browser never even revalidates. This is deliberately scoped to /static/* — html
	// (handleSsr), the offline shell (/offline), sw.js and manifest.json are served
	// elsewhere and MUST stay revalidated so a redeploy is picked up on next load.
	app.use(
		"/static/*",
		serveStatic({
			root: "dist/web",
			onFound: (_path, c) => {
				c.header("Cache-Control", "public, max-age=31536000, immutable");
			},
		}),
	);

	// Serve the service worker at the ROOT path so its scope is "/" (a SW served
	// under /static/ could only control /static/*). Built prod-only by
	// @serwist/webpack-plugin's InjectManifest → dist/web/sw.js. Registered
	// client-side by entry-client.tsx; see src/sw.ts.
	app.get("/sw.js", serveStatic({ path: "./dist/web/sw.js" }));

	// Minimal offline-shell document (design 1w9.1 §Q1). The service worker
	// precaches this URL and serves it as the fallback for a never-visited route
	// requested offline. It carries the same content-hashed CSS/scripts as a real
	// SSR page but an EMPTY app body and no dehydrated query state; the
	// data-offline-shell marker tells entry-client to client-render (not hydrate)
	// so the route loader paints from the persisted IndexedDB cache (1w9.3).
	app.get("/offline", (c) => c.html(renderOfflineShell(ssrContext)));

	app.get("*", handleSsr);

	// Use Bun.serve() explicitly — the `export default { port, fetch }`
	// pattern doesn't survive rspack's async-module wrapping, so Bun
	// can't detect it and the process exits immediately.
	Bun.serve({ port, fetch: instrument((request) => app.fetch(request)) });
	// biome-ignore lint/suspicious/noConsole: startup log
	console.log(`web-ui-ssr listening on http://localhost:${String(port)}`);
}

// ── Shared SSR handler ──────────────────────────────────────────────────

async function handleSsr(c: Context): Promise<Response> {
	const render = await getRender();
	const ssrContext = await getSsrContext();
	return render(c.req.raw, ssrContext);
}

// ── Offline shell ────────────────────────────────────────────────────────

/**
 * Renders the precached offline-shell document (design 1w9.1 §Q1). Same head as a
 * real SSR page — content-hashed CSS + the client entry scripts (both resolve from
 * the SW precache offline) — but an EMPTY <body> and no dehydrated router/query
 * state. The `data-offline-shell` marker on <html> makes entry-client client-render
 * (not hydrate), so the route loader paints from the persisted IndexedDB cache. All
 * URLs originate from our own build manifest, so no user-controlled interpolation.
 *
 * HEAD RECONCILIATION (F7). The static head links below carry `data-sm` — the marker
 * @solidjs/meta's client provider (MetaProvider, used by the route head()'s HeadContent)
 * scans for and REMOVES on a client-only render() before it (re)declares its own tags.
 * Without it the client HeadContent, finding no reconcilable prior tags, APPENDS a second
 * copy of every CSS/preload link, leaving the shell head with duplicate stylesheets that
 * never reconcile. With it, browsing from the shell reconciles the head cleanly (one link
 * per asset, the route's document.title applied) exactly as the hydration path does. The
 * links are still present for FOUC prevention before the entry runs; the reconciliation
 * only swaps them for HeadContent's equivalents once it mounts. Shell-only — the normal
 * SSR head (RouterServer) already emits its own data-sm tags and is untouched.
 */
function renderOfflineShell(ssrContext: SsrContext): string {
	const stylesheets = ssrContext.cssUrls
		.map((href) => `<link rel="stylesheet" href="${href}" data-sm="">`)
		.join("");
	const preloads = ssrContext.preloadScriptUrls
		.map((href) => `<link rel="preload" as="script" href="${href}" data-sm="">`)
		.join("");
	const scripts = ssrContext.scriptUrls
		.map((src) => `<script src="${src}" defer></script>`)
		.join("");
	return (
		`<!DOCTYPE html><html lang="en" data-offline-shell><head>` +
		`<meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
		`${stylesheets}${preloads}</head><body>${scripts}</body></html>`
	);
}

// ── SSR context helpers ─────────────────────────────────────────────────

/** Extract the web entry's CSS/JS public URLs from a dev-compile MultiStats. */
function extractSsrContextFromStats(
	stats: Rspack.Stats | Rspack.MultiStats | undefined,
): SsrContext {
	const empty: SsrContext = { cssUrls: [], scriptUrls: [], preloadScriptUrls: [] };
	if (!stats) return empty;

	const json = stats.toJson({
		all: false,
		assets: true,
		entrypoints: true,
		children: true,
	});

	const children = json.children ?? [json];
	const web = children.find((child) => child.name === "web") ?? children[0];
	if (!web) return empty;
	// biome-ignore lint/complexity/useLiteralKeys: `entrypoints` is Rspack's index signature; noPropertyAccessFromIndexSignature (TS4111) requires bracket access here.
	const assets = (web.entrypoints?.["index"]?.assets ?? []).map((asset) => asset.name);

	return {
		cssUrls: assets.filter((name) => name.endsWith(".css")).map((name) => `/${name}`),
		scriptUrls: assets.filter((name) => name.endsWith(".js")).map((name) => `/${name}`),
		// Dev serves unhashed chunks over the dev server with HMR; preload hints
		// are a prod-only optimization (see loadManifestSsrContext).
		preloadScriptUrls: [],
	};
}

/**
 * Read hashed CSS/JS URLs for the client entry from the production manifest.
 * Fails loudly at startup: an empty context would ship a page with no CSS and,
 * worse, no hydration scripts (a dead page), so manifest drift must not be
 * silently swallowed.
 */
function loadManifestSsrContext(): SsrContext {
	let initial: { js?: string[]; css?: string[] } | undefined;
	let async: { js?: string[] } | undefined;
	try {
		const manifest = JSON.parse(readFileSync("dist/web/manifest.json", "utf-8")) as {
			// `index` typed as a named optional property (not a Record index
			// signature): this code only ever reads the "index" entrypoint, so a
			// named key is both more precise and keeps dot access — avoiding the
			// noPropertyAccessFromIndexSignature (TS4111) vs biome useLiteralKeys clash.
			entries?: {
				index?: { initial?: { js?: string[]; css?: string[] }; async?: { js?: string[] } };
			};
		};
		initial = manifest.entries?.index?.initial;
		async = manifest.entries?.index?.async;
	} catch (error) {
		throw new Error(
			`Failed to load SSR context from dist/web/manifest.json (missing, malformed, or entries.index absent): ${String(error)}`,
		);
	}
	const scriptUrls = initial?.js ?? [];
	if (scriptUrls.length === 0) {
		throw new Error(
			"SSR context has no client entry scripts (dist/web/manifest.json entries.index.initial.js is empty) — the page would render without hydration. Did the web build run?",
		);
	}
	return {
		cssUrls: initial?.css ?? [],
		scriptUrls,
		// All of the entry's async (code-split) chunks, preload-hinted from the
		// SSR head so they download in parallel with the entry instead of being
		// discovered after it executes (request waterfall on hydration). The
		// manifest only maps entry -> async chunks (chunk ids are anonymous), so
		// this warms every route's async chunk rather than per-route subsets —
		// acceptable at this app's size and keeps the wiring manifest-driven
		// rather than hardcoding hashed filenames or routes.
		preloadScriptUrls: async?.js ?? [],
	};
}
