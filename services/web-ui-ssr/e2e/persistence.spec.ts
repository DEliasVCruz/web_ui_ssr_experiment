import { expect } from "@playwright/test";
import { createBackendTodo, deleteBackendTodo, test, waitForHydration } from "./fixtures";

// Proves the CLIENT-SIDE query-cache persistence layer (1w9.3): a query fetched
// online is written to IndexedDB by the per-query persister and, after a full
// reload that wipes the in-memory cache, served back from IndexedDB when the
// TodoService RPCs are offline — with zero network. NO service worker is
// involved: the HTML + JS come from the live SSR server (same-origin :3000,
// untouched); only the browser→Java RPCs are blocked.
//
// The GetTodo (detail) query is used, not ListTodos, on purpose. /todos SSR
// prefetches ONLY the list, so the detail query is never in the SSR-dehydrated
// state — the only way its data reaches the detail page after a reload is via
// IndexedDB. That makes this a genuine persistence proof, and it lets the test
// anchor hydration on /todos (the app's reliable hydration probe) and reach the
// detail purely by client-side navigation.
test.describe("query cache persistence (offlineFirst)", () => {
	test("persisted detail renders on client nav with RPCs offline", async ({ page, context }) => {
		const title = `persist-${Date.now().toString()}`;
		const seeded = await createBackendTodo(title, "persisted details");
		try {
			// 1) Load /todos online and hydrate. The list is SSR-dehydrated; the
			//    detail query is NOT.
			await page.goto("/todos", { waitUntil: "networkidle" });
			await waitForHydration(page);

			// 2) Client-navigate to the seeded todo's detail. The loader fetches
			//    GetTodo client-side (browser→Java) — it was never in memory — and the
			//    persister writes it to IndexedDB. Wait for the detail to render.
			await page.getByRole("link", { name: title, exact: true }).click();
			await expect(page).toHaveURL(new RegExp(`/todos/${seeded.id}$`));
			await expect(page.getByRole("heading", { name: title })).toBeVisible();
			await expect(page.getByText("persisted details")).toBeVisible();

			// The persister's setItem is scheduled via notifyManager after the fetch;
			// wait until IndexedDB actually holds a tanstack-query entry for GetTodo
			// before reloading, so the offline read below has something to restore.
			// This probe never CREATES the store: opening the DB blindly before
			// idb-keyval has written would create an empty one and break it, so it
			// checks existence via indexedDB.databases() first, and resolves (never
			// rejects) so a not-yet-written state simply polls again.
			await expect
				.poll(() =>
					page.evaluate(
						(id) =>
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
										const r = db
											.transaction("keyval", "readonly")
											.objectStore("keyval")
											.getAllKeys();
										r.onerror = () => {
											db.close();
											resolve(false);
										};
										r.onsuccess = () => {
											const found = r.result.some((k) => typeof k === "string" && k.includes(id));
											db.close();
											resolve(found);
										};
									};
								});
							}),
						seeded.id,
					),
				)
				.toBe(true);

			// 3) Full reload landing on the LIST route: a fresh document wipes the
			//    in-memory query cache. /todos SSR rehydrates the list but NOT the
			//    detail — so IndexedDB is now the only source of the detail data.
			await page.goto("/todos", { waitUntil: "networkidle" });
			await waitForHydration(page);

			// 4) Block every TodoService RPC at the browser network layer. Same-origin
			//    SSR (server→backend) and asset loads are untouched.
			const attemptedRpcs: string[] = [];
			await context.route("**/todo.v1.TodoService/**", (route) => {
				attemptedRpcs.push(route.request().url());
				return route.abort();
			});

			// 5) Client-navigate to the detail again. In-memory has no detail; offline
			//    lets the persister-wrapped queryFn run, and it restores GetTodo from
			//    IndexedDB WITHOUT touching the network. The detail renders from cache.
			await page.getByRole("link", { name: title, exact: true }).click();
			await expect(page).toHaveURL(new RegExp(`/todos/${seeded.id}$`));
			await expect(page.getByRole("heading", { name: title })).toBeVisible();
			await expect(page.getByText("persisted details")).toBeVisible();

			// The persisted-cache hit means the real GetTodo RPC was never attempted:
			// the persister short-circuited the network entirely.
			expect(attemptedRpcs).toEqual([]);
		} finally {
			await deleteBackendTodo(seeded.id);
		}
	});
});
