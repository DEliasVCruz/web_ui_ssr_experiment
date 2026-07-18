import { expect } from "@playwright/test";
import { createBackendTodo, deleteBackendTodo, test, waitForHydration } from "./fixtures";

// How long the spec waits for entry-client's own SW registration to become active.
// Generous: registration is deferred to window `load` and the SW must install+activate.
const SW_READY_TIMEOUT_MS = 15_000;

// Proves the SERVICE WORKER (task 1w9.2): entry-client's own registration activates,
// and a previously-visited navigation is served from the SW cache when the network —
// including the SSR server — is unreachable.
//
// SECURE-CONTEXT REALITY (design 1w9.1 §Q5): the in-container browser reaches the app
// over plain HTTP at host.docker.internal:<ephemeral port>, where SW registration is
// normally blocked (not https, not localhost). playwright:up allowlists it via
// `--unsafely-treat-insecure-origin-as-secure=*.docker.internal` (a hostname wildcard,
// matches any port). KNOWN RISK: old headless (chromedp/headless-shell) may IGNORE the
// flag (Playwright #22944).
//
// SKIP vs FAIL contract (review F3): the ONLY skip condition is an insecure context —
// `navigator.serviceWorker` missing entirely, which is the harness's environmental
// limitation, not an app regression. EVERYTHING ELSE FAILS: this spec does NOT
// register the SW itself — it passively awaits `navigator.serviceWorker.ready`, so
// the production registration in entry-client.tsx is what is under test. Under a
// secure context, removing that registration, breaking the /sw.js route, or shipping
// a sw.js that throws all leave `ready` pending → the readiness assertion FAILS (red).
//
// WHY THE OFFLINE ASSERTION IS RED-ABLE (teeth): the offline reload only renders the
// seeded link because the SW serves the cached document — with no controlling SW an
// offline reload is a net::ERR_INTERNET_DISCONNECTED error page (verified both ways
// against a secure localhost context with new-headless chromium).
test.describe("service worker (assets + navigation shell)", () => {
	test("entry-client registration activates and serves a visited navigation offline", async ({
		page,
		context,
	}) => {
		await page.goto("/todos", { waitUntil: "networkidle" });

		// ── ONLY skip: insecure context (environmental — the flag isn't honored) ──
		const secureContext = await page.evaluate(() => "serviceWorker" in navigator);
		test.skip(
			!secureContext,
			"navigator.serviceWorker is undefined — insecure context (the browser container's " +
				"--unsafely-treat-insecure-origin-as-secure flag is not honored; old headless ignores it, " +
				"Playwright #22944). Per design §Q5 the escalation is a newer-headless image, then TLS. " +
				"The data-offline suite (persistence.spec) needs no SW.",
		);

		// ── Assert entry-client's OWN registration goes active (never registers here)
		// `ready` resolves only once a registration has an active worker; if the
		// entry-client registration is missing/broken or /sw.js 404s / fails to parse,
		// it stays pending forever and this times out RED.
		const readiness = await page.evaluate(
			async (timeoutMs) =>
				Promise.race([
					navigator.serviceWorker.ready.then(() => "ready" as const),
					new Promise<"timeout">((resolve) => {
						setTimeout(() => {
							resolve("timeout");
						}, timeoutMs);
					}),
				]),
			SW_READY_TIMEOUT_MS,
		);
		expect(
			readiness,
			"entry-client's service-worker registration never became active — registration removed/broken, /sw.js unserved, or sw.js failing to install",
		).toBe("ready");

		const title = `sw-${Date.now().toString()}`;
		const seeded = await createBackendTodo(title);
		try {
			// ── Wait for the SW to control this client (skipWaiting + clientsClaim) ──
			await expect
				.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
				.toBe(true);

			// ── Reload ONLINE under SW control so the navigation gets cached ────────
			// The first goto may have happened before the SW controlled the page, so it
			// was not intercepted; this controlled reload populates the NetworkFirst
			// "pages" runtime cache with the real last-good SSR bytes for /todos (which
			// embed the dehydrated query state — the basis for byte-clean offline
			// hydration).
			await page.reload({ waitUntil: "networkidle" });
			await waitForHydration(page);
			await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();

			// The visited navigation must now live in the SW's "pages" cache.
			await expect
				.poll(() =>
					page.evaluate(async () => {
						const cache = await caches.open("pages");
						const keys = await cache.keys();
						return keys.some((req) => new URL(req.url).pathname === "/todos");
					}),
				)
				.toBe(true);

			// ── Go offline (network + SSR server unreachable) and reload ────────────
			// Served from the SW "pages" cache. The seeded todo rendering after an
			// offline reload proves the SW handed back the real cached SSR document —
			// without a SW this reload would be a net::ERR_INTERNET_DISCONNECTED page.
			await context.setOffline(true);
			await page.reload({ waitUntil: "commit" });
			await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
		} finally {
			await context.setOffline(false);
			// Leave the (isolated) context clean — belt-and-braces; the context is
			// closed by the fixture anyway.
			await page
				.evaluate(async () => {
					const regs = await navigator.serviceWorker.getRegistrations();
					await Promise.all(regs.map((reg) => reg.unregister()));
					const keys = await caches.keys();
					await Promise.all(keys.map((key) => caches.delete(key)));
				})
				.catch(() => undefined);
			await deleteBackendTodo(seeded.id);
		}
	});
});
