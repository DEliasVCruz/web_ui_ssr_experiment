import { describe, expect, test } from "bun:test";
import { CacheFirst, NetworkFirst } from "serwist";
import {
	ASSETS_MAX_AGE_SECONDS,
	ASSETS_MAX_ENTRIES,
	buildSwOptions,
	NAVIGATION_NETWORK_TIMEOUT_SECONDS,
	PAGES_MAX_AGE_SECONDS,
	PAGES_MAX_ENTRIES,
} from "./sw-config";

// The review's sanctioned range for the navigation network timeout (F1: 3–5 s).
const REVIEW_TIMEOUT_MIN_SECONDS = 3;
const REVIEW_TIMEOUT_MAX_SECONDS = 5;
// images + fonts + pages — the three runtime-caching rules buildSwOptions defines.
const RUNTIME_CACHE_RULE_COUNT = 3;

// Pins the service-worker configuration (task 1w9.2, review F1/F2): Serwist configs
// are data + strategy instances, so the route matchers, the backend-origin
// exclusion, the navigation network timeout, and the cache-expiration bounds are
// all assertable without a worker runtime. What is NOT unit-testable here is
// Serwist's fetch-event dispatch itself — that behavior is covered by e2e/sw.spec.ts
// (under a secure context) and was verified manually against localhost.

/** Minimal stand-in for RouteMatchCallbackOptions: the matchers only read
 * `request.destination` / `request.mode` and `sameOrigin`. `Request.destination`
 * is read-only on real constructed Requests (always ""), hence the structural fake. */
function matchParam(opts: { destination?: string; mode?: string; sameOrigin?: boolean }) {
	return {
		request: { destination: opts.destination ?? "", mode: opts.mode ?? "cors" },
		sameOrigin: opts.sameOrigin ?? true,
		url: new URL("http://localhost:3000/x"),
		event: {},
	} as unknown as Parameters<Extract<Matcher, (...args: never[]) => unknown>>[0];
}

type Matcher = NonNullable<ReturnType<typeof buildSwOptions>["runtimeCaching"]>[number]["matcher"];

function callMatcher(matcher: Matcher, param: ReturnType<typeof matchParam>): boolean {
	if (typeof matcher !== "function") throw new Error("expected a RouteMatchCallback function");
	return Boolean(matcher(param));
}

function getOptions() {
	const options = buildSwOptions([]);
	const caching = options.runtimeCaching;
	if (!caching) throw new Error("runtimeCaching missing");
	return { options, caching };
}

/** Reads the private-but-runtime-present config off strategy/plugin instances.
 * Fragile against serwist internals by design — if a serwist upgrade renames these,
 * this test failing is the signal to re-verify the timeout/expiration behavior.
 * Named-props shape (not a Record) so dot access satisfies both TS4111 and biome. */
interface ExpirationConfigShape {
	maxEntries?: unknown;
	maxAgeSeconds?: unknown;
	purgeOnQuotaError?: unknown;
}
function expirationConfig(handler: { plugins: unknown[] }): ExpirationConfigShape {
	const plugin = handler.plugins.find(
		(p): p is { _config: ExpirationConfigShape } =>
			typeof p === "object" && p !== null && "_config" in p,
	);
	if (!plugin) throw new Error("no ExpirationPlugin on strategy");
	return plugin._config;
}

describe("buildSwOptions (sw runtime config)", () => {
	test("lifecycle flags: skipWaiting + clientsClaim + navigationPreload (design §Q3)", () => {
		const { options } = getOptions();
		expect(options.skipWaiting).toBe(true);
		expect(options.clientsClaim).toBe(true);
		expect(options.navigationPreload).toBe(true);
	});

	test("precache entries pass through", () => {
		const entries = [{ url: "/static/js/a.js", revision: null }];
		expect(buildSwOptions(entries).precacheEntries).toBe(entries);
	});

	test("images/fonts: same-origin CacheFirst; cross-origin never matches", () => {
		const { caching } = getOptions();
		const [images, fonts] = caching;
		if (!images || !fonts) throw new Error("expected image + font rules");
		expect(images.handler).toBeInstanceOf(CacheFirst);
		expect(fonts.handler).toBeInstanceOf(CacheFirst);
		expect((images.handler as CacheFirst).cacheName).toBe("images");
		expect((fonts.handler as CacheFirst).cacheName).toBe("fonts");

		expect(callMatcher(images.matcher, matchParam({ destination: "image" }))).toBe(true);
		expect(
			callMatcher(images.matcher, matchParam({ destination: "image", sameOrigin: false })),
		).toBe(false);
		expect(callMatcher(fonts.matcher, matchParam({ destination: "font" }))).toBe(true);
		expect(callMatcher(fonts.matcher, matchParam({ destination: "font", sameOrigin: false }))).toBe(
			false,
		);
	});

	test("navigations: NetworkFirst on 'pages' WITH a network timeout (review F1)", () => {
		const { caching } = getOptions();
		const pages = caching[2];
		if (!pages) throw new Error("expected navigation rule");
		expect(pages.handler).toBeInstanceOf(NetworkFirst);
		expect((pages.handler as NetworkFirst).cacheName).toBe("pages");
		// Private field read on purpose: without networkTimeoutSeconds, NetworkFirst
		// only falls back to cache on hard rejection and lie-fi hangs navigation.
		expect(
			(pages.handler as unknown as { _networkTimeoutSeconds: number })._networkTimeoutSeconds,
		).toBe(NAVIGATION_NETWORK_TIMEOUT_SECONDS);
		expect(NAVIGATION_NETWORK_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(REVIEW_TIMEOUT_MIN_SECONDS);
		expect(NAVIGATION_NETWORK_TIMEOUT_SECONDS).toBeLessThanOrEqual(REVIEW_TIMEOUT_MAX_SECONDS);

		expect(callMatcher(pages.matcher, matchParam({ mode: "navigate" }))).toBe(true);
		expect(callMatcher(pages.matcher, matchParam({ mode: "cors" }))).toBe(false);
	});

	test("every runtime cache is bounded by an ExpirationPlugin with purgeOnQuotaError (review F2)", () => {
		const { caching } = getOptions();
		expect(caching).toHaveLength(RUNTIME_CACHE_RULE_COUNT);
		const [images, fonts, pages] = caching as [
			(typeof caching)[number],
			(typeof caching)[number],
			(typeof caching)[number],
		];
		for (const rule of [images, fonts]) {
			const config = expirationConfig(rule.handler as CacheFirst);
			expect(config.maxEntries).toBe(ASSETS_MAX_ENTRIES);
			expect(config.maxAgeSeconds).toBe(ASSETS_MAX_AGE_SECONDS);
			expect(config.purgeOnQuotaError).toBe(true);
		}
		const pagesConfig = expirationConfig(pages.handler as NetworkFirst);
		expect(pagesConfig.maxEntries).toBe(PAGES_MAX_ENTRIES);
		expect(pagesConfig.maxAgeSeconds).toBe(PAGES_MAX_AGE_SECONDS);
		expect(pagesConfig.purgeOnQuotaError).toBe(true);
	});

	test("backend-origin exclusion: NO matcher touches an RPC-shaped request (design §Q2)", () => {
		const { caching } = getOptions();
		// A TodoService call: cross-origin fetch, destination "" — binary GET reads
		// and POST mutations alike. POSTs are additionally excluded by the default
		// GET-only method on every rule; this pins that even the GETs never match.
		const rpc = matchParam({ destination: "", mode: "cors", sameOrigin: false });
		// And a same-origin plain fetch (destination "") must not match either.
		const sameOriginFetch = matchParam({ destination: "", mode: "cors", sameOrigin: true });
		for (const rule of caching) {
			expect(callMatcher(rule.matcher, rpc)).toBe(false);
			expect(callMatcher(rule.matcher, sameOriginFetch)).toBe(false);
			// Belt-and-braces: no rule overrides the GET-only default to catch POSTs.
			expect(rule.method ?? "GET").toBe("GET");
		}
	});

	test("offline fallback: precached /offline serves failed document navigations (design §Q1)", () => {
		const { options } = getOptions();
		const entries = options.fallbacks?.entries;
		if (!entries) throw new Error("fallbacks.entries missing");
		expect(entries).toHaveLength(1);
		const fallback = entries[0];
		if (!fallback) throw new Error("fallback entry missing");
		expect(fallback.url).toBe("/offline");
		const asDoc = { request: { destination: "document" } };
		const asImage = { request: { destination: "image" } };
		type FallbackParam = Parameters<typeof fallback.matcher>[0];
		expect(fallback.matcher(asDoc as unknown as FallbackParam)).toBe(true);
		expect(fallback.matcher(asImage as unknown as FallbackParam)).toBe(false);
	});
});
