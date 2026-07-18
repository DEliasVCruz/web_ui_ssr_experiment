import { expect, type Page } from "@playwright/test";
import { createBackendTodo, deleteBackendTodo, test, waitForHydration } from "./fixtures";

// The OFFLINE-SHELL path (service worker 1w9.2 + persistence 1w9.3, design §Q1) —
// the one offline branch with ZERO prior e2e coverage. A NEVER-VISITED route
// requested offline has no per-URL entry in the SW "pages" cache, so the SW serves
// the PRECACHED /offline shell instead: a document carrying `data-offline-shell`,
// an empty body, and no dehydrated state. entry-client reads that marker and
// `render()`s (not `hydrate()`s), and the route loader paints from the persisted
// IndexedDB query cache.
//
// context.setOffline(true) is load-bearing here (design §Q1 note): it blocks ALL
// browser network — INCLUDING the SW's own NetworkFirst fetch — so the only thing
// that can answer the navigation is Cache Storage. A rendered detail after that is
// therefore proof the SW served the precached shell, not a lucky live response.
//
// SKIP vs FAIL contract (mirrors sw.spec): the ONLY skip is an insecure context
// (`navigator.serviceWorker` undefined — the browser's secure-origin flag not
// honored). Under a secure context this genuinely executes; a missing shell, a
// missing marker, a hydrate-instead-of-render, or an empty persisted cache all
// FAIL (red), never skip.

const SW_READY_TIMEOUT_MS = 15_000;

/** Resolves true once IndexedDB holds a persisted query entry for the given id. */
function idbHasDetail(page: Page, id: string): Promise<boolean> {
	return page.evaluate(
		(todoId) =>
			new Promise<boolean>((resolve) => {
				void indexedDB.databases().then((dbs) => {
					if (!dbs.some((d) => d.name === "keyval-store")) {
						resolve(false);
						return;
					}
					const req = indexedDB.open("keyval-store");
					req.onerror = () => {
						resolve(false);
					};
					req.onsuccess = () => {
						const db = req.result;
						if (!db.objectStoreNames.contains("keyval")) {
							db.close();
							resolve(false);
							return;
						}
						const r = db.transaction("keyval", "readonly").objectStore("keyval").getAllKeys();
						r.onerror = () => {
							db.close();
							resolve(false);
						};
						r.onsuccess = () => {
							const found = r.result.some((k) => typeof k === "string" && k.includes(todoId));
							db.close();
							resolve(found);
						};
					};
				});
			}),
		id,
	);
}

test.describe("offline shell (never-visited route, SW-served)", () => {
	test("never-visited route offline → SW serves the precached /offline shell → client-renders from the persisted cache", async ({
		page,
		context,
	}) => {
		const title = `offline-shell-${Date.now().toString()}`;
		const seeded = await createBackendTodo(title, "shell details");
		try {
			// ── 1) Load /todos online, hydrate, and let the SW take control ──────────
			await page.goto("/todos", { waitUntil: "networkidle" });
			await waitForHydration(page);

			// ── ONLY skip: insecure context (environmental — the flag isn't honored) ──
			const secureContext = await page.evaluate(() => "serviceWorker" in navigator);
			test.skip(
				!secureContext,
				"navigator.serviceWorker is undefined — insecure context (the browser container's " +
					"--unsafely-treat-insecure-origin-as-secure flag is not honored; old headless ignores it, " +
					"Playwright #22944). The new-headless image honors it; see e2e/sw.spec.ts.",
			);

			// entry-client's own registration must go active, then control this client.
			const readiness = await page.evaluate(
				(timeoutMs) =>
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
			expect(readiness, "entry-client's service-worker registration never became active").toBe(
				"ready",
			);
			await expect
				.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
				.toBe(true);

			// ── 2) CLIENT-navigate (SPA) to the detail: GetTodo is fetched and the
			// 1w9.3 persister writes it to IndexedDB. An SPA navigation issues NO
			// document request, so /todos/<id> never enters the SW "pages" cache — it
			// stays a genuinely never-visited *document* URL. ─────────────────────────
			await page.getByRole("link", { name: title, exact: true }).click();
			await expect(page).toHaveURL(new RegExp(`/todos/${seeded.id}$`));
			await expect(page.getByRole("heading", { name: title })).toBeVisible();
			await expect(page.getByText("shell details")).toBeVisible();
			await expect.poll(() => idbHasDetail(page, seeded.id)).toBe(true);

			// The detail document URL is NOT in the "pages" cache (SPA nav, never fetched
			// as a document) — so the offline navigation below can only be answered by
			// the precached /offline fallback, not a per-URL cache hit.
			expect(
				await page.evaluate(async (id) => {
					const cache = await caches.open("pages");
					const keys = await cache.keys();
					return keys.some((req) => new URL(req.url).pathname === `/todos/${id}`);
				}, seeded.id),
			).toBe(false);

			// ── 3) Go fully offline (blocks the network AND the SW's own fetches) ─────
			await context.setOffline(true);

			// ── 4) Full-DOCUMENT request the never-visited detail URL ────────────────
			// NetworkFirst misses (offline) with no per-URL cache entry → the precached
			// /offline shell is served: data-offline-shell, empty body, no dehydrated
			// state. Without the SW this would be net::ERR_INTERNET_DISCONNECTED.
			await page.goto(`/todos/${seeded.id}`, { waitUntil: "commit" });

			// The served document is the precached shell, not a live SSR page.
			await expect
				.poll(() =>
					page.evaluate(() => document.documentElement.hasAttribute("data-offline-shell")),
				)
				.toBe(true);

			// ── 5) entry-client render()'d the route and the loader painted the detail
			// from the persisted IndexedDB cache — offline, from Cache Storage + IDB
			// alone. ─────────────────────────────────────────────────────────────────
			await expect(page.getByRole("heading", { name: title })).toBeVisible();
			await expect(page.getByText("shell details")).toBeVisible();

			// ── 6) HEAD RECONCILES CLEANLY in the shell render path (F7). The route
			// head()'s client HeadContent reconciles against the shell's static <head> only
			// because EVERY static tag it also declares (charset + viewport metas AND the
			// CSS/preload links) carries `data-sm` (renderOfflineShell) — the marker
			// @solidjs/meta's client provider removes before it (re)declares. Without it the
			// provider APPENDS a second copy of each, leaving duplicate metas/stylesheets that
			// never reconcile. Assert the detail route's title applied AND exactly one of each
			// reconciled head tag (no duplicates) — what fails without the fix. This also
			// guards the undocumented data-sm contract against future @solidjs/meta bumps. ──
			await expect.poll(() => page.title()).toBe(`${title} | Web UI SSR`);
			await expect.poll(() => page.locator("head title").count()).toBe(1);
			await expect.poll(() => page.locator("head meta[charset]").count()).toBe(1);
			await expect.poll(() => page.locator('head meta[name="viewport"]').count()).toBe(1);
			await expect.poll(() => page.locator('head link[rel="stylesheet"]').count()).toBe(1);

			// …and it keeps reconciling across in-shell SPA navigation: hopping to the
			// (persisted) list updates the title, still with a single reconciled tag of each.
			await page.getByRole("link", { name: "Todos" }).first().click();
			await expect(page).toHaveURL(/\/todos$/);
			await expect.poll(() => page.title()).toBe("Todos | Web UI SSR");
			await expect.poll(() => page.locator("head title").count()).toBe(1);
			await expect.poll(() => page.locator("head meta[charset]").count()).toBe(1);
			await expect.poll(() => page.locator('head meta[name="viewport"]').count()).toBe(1);
			await expect.poll(() => page.locator('head link[rel="stylesheet"]').count()).toBe(1);
		} finally {
			await context.setOffline(false);
			// Leave the isolated context clean (the fixture closes it anyway).
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
