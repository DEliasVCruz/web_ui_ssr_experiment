// Service worker for web-ui-ssr — PRODUCTION-ONLY.
//
// Built by @serwist/webpack-plugin's InjectManifest (see rsbuild.config.ts), which
// compiles this file with a child compiler and replaces `self.__SW_MANIFEST` with
// the content-hashed precache list for the *same* web build whose manifest.json the
// SSR head reads. It is emitted to dist/web/sw.js and served at /sw.js (root scope)
// by the prod server; entry-client.tsx registers it client-side, prod-only.
//
// Type environment: this module runs in a ServiceWorkerGlobalScope, NOT a DOM
// Window — it is excluded from tsconfig.json and type-checked via tsconfig.sw.json
// (lib: ["WebWorker"]). Do not import DOM-only globals here.
//
// Scope decisions (design 1w9.1 — offline-support-design):
//   §Q3 precache the build's content-hashed assets → free invalidation on redeploy
//       (new hashes → new manifest → new sw.js → skipWaiting activates → Serwist
//       drops stale precache entries).
//   §Q2 CacheFirst same-origin images/fonts.
//   §Q1 NetworkFirst navigations, caching the real last-good SSR response per URL.
//       The cached HTML carries its own dehydrated query state, so an offline
//       hydrate() matches the served bytes → byte-clean offline hydration. The
//       persisted IndexedDB cache reconciles AFTER hydration, never during it.
//   §Q1 Navigation misses (never-visited routes offline) fall back to a precached
//       minimal offline shell (/offline) that client-renders from the persisted
//       query cache (1w9.3). See entry-client's offline-shell branch.
//   §Q2 The business-logic origin (todo.v1.TodoService/*) is NEVER matched here:
//       the TanStack persister owns the data-offline story, a second HTTP cache
//       would desync it, and SW-served RPCs would corrupt the wide-event/trace
//       count model (iq2.4). Those cross-origin RPCs simply pass through untouched
//       because no runtime-caching rule matches their origin.
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, NetworkFirst, Serwist } from "serwist";

declare global {
	interface WorkerGlobalScope extends SerwistGlobalConfig {
		// Injected at build time by @serwist/webpack-plugin (InjectManifest). Left
		// `undefined` in dev builds (disablePrecacheManifest), hence the union.
		// biome-ignore lint/style/useNamingConvention: name must match the injection point the plugin replaces (self.__SW_MANIFEST)
		__SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
	}
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
	// `?? []` satisfies exactOptionalPropertyTypes (the injected manifest is typed
	// `... | undefined` for dev builds); prod always has it injected by InjectManifest.
	precacheEntries: self.__SW_MANIFEST ?? [],
	// Single-window app with no cross-tab data contract: activate a new SW
	// immediately and take control of open clients (design §Q3).
	skipWaiting: true,
	clientsClaim: true,
	// Pure ONLINE optimisation: lets NetworkFirst navigations start the network
	// request without paying SW-boot latency. Offline it is a harmless no-op.
	navigationPreload: true,
	runtimeCaching: [
		{
			// Same-origin images: content-addressed, safe to serve cache-first.
			matcher: ({ request, sameOrigin }) => sameOrigin && request.destination === "image",
			handler: new CacheFirst({ cacheName: "images" }),
		},
		{
			// Same-origin fonts.
			matcher: ({ request, sameOrigin }) => sameOrigin && request.destination === "font",
			handler: new CacheFirst({ cacheName: "fonts" }),
		},
		{
			// Full-document navigations: prefer the live SSR response (with its
			// embedded dehydrated query cache); fall back to the last-good cached
			// copy per URL when the network is unreachable.
			matcher: ({ request }) => request.mode === "navigate",
			handler: new NetworkFirst({ cacheName: "pages" }),
		},
	],
	fallbacks: {
		// Only takes effect because runtimeCaching is defined: Serwist attaches a
		// PrecacheFallbackPlugin to each strategy, so an offline navigation with no
		// per-URL cache hit is served the precached /offline shell (added to the
		// precache via InjectManifest.additionalPrecacheEntries in rsbuild.config.ts).
		entries: [
			{
				url: "/offline",
				matcher: ({ request }) => request.destination === "document",
			},
		],
	},
});

serwist.addEventListeners();
