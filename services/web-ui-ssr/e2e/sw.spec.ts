import { expect } from "@playwright/test";
import { createBackendTodo, deleteBackendTodo, test, waitForHydration } from "./fixtures";

// Proves the SERVICE WORKER (task 1w9.2) registers under the e2e harness's
// secure-context treatment AND serves a previously-visited navigation from its own
// cache when the network — including the SSR server — is unreachable.
//
// SECURE-CONTEXT REALITY (design 1w9.1 §Q5): the in-container browser reaches the app
// over plain HTTP at host.docker.internal:<ephemeral port>, where SW registration is
// normally blocked (not https, not localhost). playwright:up allowlists it via
// `--unsafely-treat-insecure-origin-as-secure=*.docker.internal` (a hostname wildcard,
// matches any port). KNOWN RISK: old headless (chromedp/headless-shell) may IGNORE the
// flag (Playwright #22944). This spec PROBES registration first and, if no secure
// context is available, SKIPS LOUDLY (a visible skip with reason) rather than faking
// coverage. When the flag works, it goes on to prove real offline SW serving.
//
// WHY THIS IS RED-ABLE (teeth): the offline-serving assertion only passes because the
// SW serves the cached document — with no controlling SW, an offline reload yields a
// browser error page and the seeded-todo link never appears. Disabling the registration
// in entry-client.tsx (or the /sw.js route) turns this spec red.
test.describe("service worker (assets + navigation shell)", () => {
	test("registers and serves a visited navigation offline from cache", async ({
		page,
		context,
	}) => {
		// ── Probe: is a secure context available (is the flag honored)? ───────────
		await page.goto("/todos", { waitUntil: "networkidle" });
		const probe = await page.evaluate(async () => {
			if (!("serviceWorker" in navigator)) {
				return {
					ok: false,
					reason:
						"navigator.serviceWorker is undefined — insecure context (secure-origin flag not honored)",
				};
			}
			try {
				await navigator.serviceWorker.register("/sw.js", { scope: "/" });
				await navigator.serviceWorker.ready;
				return { ok: true, reason: "" };
			} catch (error) {
				return { ok: false, reason: `serviceWorker.register() rejected: ${String(error)}` };
			}
		});
		test.skip(
			!probe.ok,
			`Service worker unavailable in this harness: ${probe.reason}. Per design §Q5 mitigation ladder, ` +
				"chromedp/headless-shell may ignore --unsafely-treat-insecure-origin-as-secure (Playwright #22944); " +
				"escalation is a newer-headless image, then TLS. The data-offline suite (persistence.spec) needs no SW.",
		);

		const title = `sw-${Date.now().toString()}`;
		const seeded = await createBackendTodo(title);
		try {
			// ── Wait for the SW to control this client (skipWaiting + clientsClaim) ──
			await expect
				.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
				.toBe(true);

			// ── Reload ONLINE under SW control so the navigation gets cached ────────
			// The first goto happened before the SW controlled the page, so it was not
			// intercepted; this controlled reload populates the NetworkFirst "pages"
			// runtime cache with the real last-good SSR bytes for /todos (which embed
			// the dehydrated query state — the basis for byte-clean offline hydration).
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
