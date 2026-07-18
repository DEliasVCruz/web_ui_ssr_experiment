// Service-worker configuration, extracted from src/sw.ts so it is unit-testable:
// Serwist configs are plain data + strategy instances, so the route matchers, the
// backend-origin exclusion, the navigation network timeout, and the cache-expiration
// bounds can all be pinned by bun tests (src/sw-config.test.ts) without a worker
// runtime. sw.ts constructs `new Serwist(buildSwOptions(self.__SW_MANIFEST ?? []))`.
//
// This module is deliberately GLOBAL-FREE (no `self`, no worker/DOM globals) so it
// type-checks under both the DOM project (tsconfig.json — where its unit test lives)
// and the WebWorker project (tsconfig.sw.json — reached via sw.ts's import).
import type { PrecacheEntry, SerwistOptions } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkFirst } from "serwist";

const SECONDS_PER_DAY = 24 * 60 * 60;
// Retention windows as day counts (named so the `* SECONDS_PER_DAY` products below
// carry no bare magic numbers). `pages` matches the query persister's ~7d maxAge.
const PAGES_MAX_AGE_DAYS = 7;
const ASSETS_MAX_AGE_DAYS = 30;

/**
 * NetworkFirst only falls back to cache on a HARD network rejection; without a
 * timeout, a lie-fi/slow network hangs the navigation forever and the cached page
 * never serves. 4s balances "give the live SSR a fair chance" against "don't leave
 * the user staring at a blank tab" (review F1).
 */
export const NAVIGATION_NETWORK_TIMEOUT_SECONDS = 4;

/**
 * Cache bounds (review F2): unbounded runtime caches grow forever (`pages` stores
 * every visited URL's full HTML — distinct query strings are distinct entries), and
 * browser quota eviction, when it strikes, can wipe the WHOLE origin including the
 * 1w9.3 IndexedDB persistence. Bounds + purgeOnQuotaError make these caches the
 * first sacrifice under quota pressure instead of the trigger for origin eviction.
 *
 * pages: 50 entries / 7d — aligned with the query persister's ~7d maxAge (a cached
 * shell older than the persisted data it would reconcile against has no value).
 * images/fonts: 100 entries / 30d — content-addressed, safe to keep long.
 */
export const PAGES_MAX_ENTRIES = 50;
export const PAGES_MAX_AGE_SECONDS = PAGES_MAX_AGE_DAYS * SECONDS_PER_DAY;
export const ASSETS_MAX_ENTRIES = 100;
export const ASSETS_MAX_AGE_SECONDS = ASSETS_MAX_AGE_DAYS * SECONDS_PER_DAY;

/**
 * Builds the full Serwist constructor options (design 1w9.1 §Q1–Q3):
 * - precache the injected build manifest (content-hashed → free invalidation);
 * - CacheFirst same-origin images/fonts; NetworkFirst navigations caching the real
 *   last-good SSR response per visited URL (byte-clean offline hydration);
 * - precached /offline shell fallback for never-visited routes;
 * - skipWaiting + clientsClaim + navigationPreload;
 * - NO rule matches the business-logic origin (`…/todo.v1.TodoService/*`): the
 *   TanStack persister owns data-offline, a second HTTP cache would desync it, and
 *   SW-served RPCs would corrupt the iq2.4 wide-event/trace count model. Those
 *   cross-origin fetches pass through untouched.
 */
export function buildSwOptions(precacheEntries: (PrecacheEntry | string)[]): SerwistOptions {
	return {
		precacheEntries,
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
				handler: new CacheFirst({
					cacheName: "images",
					plugins: [
						new ExpirationPlugin({
							maxEntries: ASSETS_MAX_ENTRIES,
							maxAgeSeconds: ASSETS_MAX_AGE_SECONDS,
							purgeOnQuotaError: true,
						}),
					],
				}),
			},
			{
				// Same-origin fonts.
				matcher: ({ request, sameOrigin }) => sameOrigin && request.destination === "font",
				handler: new CacheFirst({
					cacheName: "fonts",
					plugins: [
						new ExpirationPlugin({
							maxEntries: ASSETS_MAX_ENTRIES,
							maxAgeSeconds: ASSETS_MAX_AGE_SECONDS,
							purgeOnQuotaError: true,
						}),
					],
				}),
			},
			{
				// Full-document navigations: prefer the live SSR response (with its
				// embedded dehydrated query cache) but only up to the timeout; fall
				// back to the last-good cached copy per URL when the network is
				// unreachable OR merely too slow (lie-fi).
				matcher: ({ request }) => request.mode === "navigate",
				handler: new NetworkFirst({
					cacheName: "pages",
					networkTimeoutSeconds: NAVIGATION_NETWORK_TIMEOUT_SECONDS,
					plugins: [
						new ExpirationPlugin({
							maxEntries: PAGES_MAX_ENTRIES,
							maxAgeSeconds: PAGES_MAX_AGE_SECONDS,
							purgeOnQuotaError: true,
						}),
					],
				}),
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
	};
}
