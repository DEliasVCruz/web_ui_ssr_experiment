import { expect, type Page } from "@playwright/test";
import {
	ADD_INPUT_SELECTOR,
	BACKEND_URL,
	createBackendTodo,
	deleteBackendTodo,
	getBackendTodo,
	listBackendTodos,
	test,
	waitForHydration,
} from "./fixtures";

// Offline mutation queue + resumption + offline UI (task 1w9.4). NO service worker
// is involved (that is 1w9.2's scope): the HTML + JS come from the live SSR server
// (same-origin :3000, untouched); we only make the app BELIEVE it is offline so
// mutations pause and queue. TanStack's onlineManager tracks connectivity purely
// via window online/offline EVENTS (it ignores navigator.onLine), so dispatching a
// synthetic `offline` event pauses mutations while leaving the document reachable —
// which is exactly what the reload-survival proof needs (a fully-offline transport
// would block the reload itself).

const FLUSH_TIMEOUT_MS = 10_000;
const HTTP_OK = 200;

// The browser wide-event line shape we assert on (snake_case = the on-the-wire
// JSON contract, as in browser-trace.spec.ts).
interface BrowserWideEventLine {
	component?: string;
	action?: string;
	trace_id?: string;
	offline_queued?: boolean;
}

/** Make the app believe it is offline: onlineManager + the banner both key off this. */
async function goOffline(page: Page): Promise<void> {
	await page.evaluate(() => window.dispatchEvent(new Event("offline")));
}
/** Reconnect: onlineManager flips online and the queue flushes (FIFO). */
async function goOnline(page: Page): Promise<void> {
	await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

/** The client-minted UUID a row carries, read from its detail link (`/todos/<id>`). */
async function rowClientId(page: Page, title: string): Promise<string> {
	const href = await page
		.locator("main ul li", { hasText: title })
		.locator("a")
		.getAttribute("href");
	const id = href?.split("/todos/")[1];
	if (id === undefined || id.length === 0) {
		throw new Error(`no client id in row href: ${String(href)}`);
	}
	return id;
}

/** Polls until the paused-mutation queue has been persisted to IndexedDB. */
async function waitForQueuePersisted(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
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
										.get("web-ui-paused-mutations");
									r.onerror = () => {
										db.close();
										resolve(false);
									};
									r.onsuccess = () => {
										const raw = r.result as string | undefined;
										db.close();
										resolve(typeof raw === "string" && raw.includes("createTodo"));
									};
								};
							});
						}),
				),
			{ timeout: FLUSH_TIMEOUT_MS },
		)
		.toBe(true);
}

test.describe("offline mutation queue", () => {
	test("queue create+toggle offline, then flush on reconnect — server converges, ids stable", async ({
		page,
		context,
	}) => {
		// A pre-existing server todo so we can queue a TOGGLE offline (an optimistic
		// create row is disabled while pending, so it can't itself be toggled).
		const seeded = await createBackendTodo(`E2E_Q_SEED_${String(Date.now())}`);
		const createdTitle = `E2E_Q_CREATE_${String(Date.now())}`;
		let createdId: string | undefined;

		// Capture the browser wide event emitted for the create when it REPLAYS, and
		// the replayed RPC's traceparent — the offline_queued trace-correlation proof
		// (teeth b: read activeAction at flush and this loses the header/flag).
		const browserEvents: BrowserWideEventLine[] = [];
		page.on("console", (msg) => {
			const text = msg.text();
			if (!text.startsWith("{")) return;
			try {
				const parsed = JSON.parse(text) as BrowserWideEventLine;
				if (parsed.component === "web-ui-browser" && parsed.action !== undefined) {
					browserEvents.push(parsed);
				}
			} catch {
				// not one of our JSON wide-event lines
			}
		});
		let createTraceparent: string | undefined;
		await page.route("**/todo.v1.TodoService/CreateTodo", async (route) => {
			if (route.request().method() === "POST") {
				const { traceparent } = route.request().headers();
				createTraceparent ??= traceparent;
			}
			await route.continue();
		});

		try {
			await page.goto("/todos");
			await waitForHydration(page);

			// ── Go offline ──────────────────────────────────────────────────────────
			// Real offline (navigator.onLine=false + the offline event) so the enqueue
			// is honestly captured as offline_queued. This test never reloads, so a
			// fully-offline transport is safe (the reload-survival test can't use it).
			await context.setOffline(true);
			await expect(page.getByText("You’re offline.", { exact: false })).toBeVisible();

			// Queue a TOGGLE of the seeded row.
			const seededRow = page.locator("main ul li", { hasText: seeded.title });
			const seededCheckbox = seededRow.locator('input[type="checkbox"]');
			await seededRow.locator('[data-part="control"]').click();
			await expect(seededCheckbox).toBeChecked(); // optimistic reflection

			// Queue a CREATE.
			await page.locator(ADD_INPUT_SELECTOR).fill(createdTitle);
			await page.getByRole("button", { name: "Add", exact: true }).click();
			const createdRow = page.locator("main ul li", { hasText: createdTitle });
			await expect(createdRow).toBeVisible();
			await expect(page.locator("main ul li[data-pending]", { hasText: createdTitle })).toHaveCount(
				1,
			); // optimistic, still queued

			createdId = await rowClientId(page, createdTitle);
			expect(createdId).toMatch(/^[0-9a-f-]{36}$/); // lowercase canonical uuid

			// Nothing hit the server yet — the writes are queued, not sent.
			const beforeFlush = await listBackendTodos();
			expect(beforeFlush.some((t) => t.title === createdTitle)).toBe(false);
			expect(beforeFlush.find((t) => t.id === seeded.id)?.completed ?? false).toBe(false);

			// ── Reconnect: the queue flushes FIFO ────────────────────────────────────
			await context.setOffline(false);

			// Server converges: the toggle AND the create both land.
			await expect
				.poll(() => getBackendTodo(seeded.id).then((t) => t.completed ?? false), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);
			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.title === createdTitle)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);

			// ID STABILITY: the created todo carries the SAME client id on the server,
			// and the row still links to that id after the flush (no temp→real swap).
			const serverCreated = (await listBackendTodos()).find((t) => t.title === createdTitle);
			expect(serverCreated?.id).toBe(createdId);
			await expect(page.locator("main ul li", { hasText: createdTitle })).toHaveCount(1);
			expect(await rowClientId(page, createdTitle)).toBe(createdId);

			// TRACE (teeth b): the create replayed as a queued action — one wide event
			// flagged offline_queued, correlated with the replayed RPC's traceparent.
			await expect
				.poll(() => browserEvents.some((e) => e.action === "create_todo" && e.offline_queued), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);
			expect(createTraceparent, "replayed create carried a traceparent").toBeDefined();
			const headerTrace = /^00-([0-9a-f]{32})-/.exec(createTraceparent ?? "")?.[1];
			const queuedCreateEvent = browserEvents.find(
				(e) => e.action === "create_todo" && e.offline_queued,
			);
			expect(queuedCreateEvent?.trace_id).toBe(headerTrace);
		} finally {
			await deleteBackendTodo(seeded.id);
			const leftover = (await listBackendTodos()).find((t) => t.title === createdTitle);
			if (leftover) await deleteBackendTodo(leftover.id);
		}
	});

	test("reload mid-queue: the queued create survives the reload and flushes on resumption", async ({
		page,
	}) => {
		// THE survival proof. Queue a create offline, reload the document (which the
		// live server still serves — only the RPCs were ever paused), and assert the
		// mutation — persisted to IndexedDB — is rehydrated and flushed on startup.
		const title = `E2E_RELOAD_${String(Date.now())}`;
		let clientId: string | undefined;
		try {
			await page.goto("/todos");
			await waitForHydration(page);

			await goOffline(page);
			await page.locator(ADD_INPUT_SELECTOR).fill(title);
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await expect(page.locator("main ul li", { hasText: title })).toBeVisible();
			clientId = await rowClientId(page, title);

			// Queued, not sent; and persisted to IndexedDB so it can outlive the doc.
			expect((await listBackendTodos()).some((t) => t.title === title)).toBe(false);
			await waitForQueuePersisted(page);

			// ── Reload: fresh document, in-memory queue wiped ────────────────────────
			await page.goto("/todos");
			await waitForHydration(page);

			// Resumption (restore-from-IndexedDB + resumePausedMutations at startup)
			// flushes the survivor — with its ORIGINAL client id.
			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.title === title)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);
			const server = (await listBackendTodos()).find((t) => t.title === title);
			expect(server?.id).toBe(clientId);
			await expect(page.locator("main ul li", { hasText: title })).toBeVisible();
		} finally {
			const leftover = (await listBackendTodos()).find((t) => t.title === title);
			if (leftover) await deleteBackendTodo(leftover.id);
		}
	});

	test("double-flush of the same client id is idempotent — no duplicate row", async ({ page }) => {
		// The queue guarantees at-least-once replay; the client id makes it safe. Queue
		// a create offline, flush it, then RE-SEND the identical id+title (simulating a
		// double flush / crash-mid-flush replay). First-write-wins → still one row, one id.
		const title = `E2E_IDEMPOTENT_${String(Date.now())}`;
		let clientId: string | undefined;
		try {
			await page.goto("/todos");
			await waitForHydration(page);

			await goOffline(page);
			await page.locator(ADD_INPUT_SELECTOR).fill(title);
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await expect(page.locator("main ul li", { hasText: title })).toBeVisible();
			clientId = await rowClientId(page, title);

			await goOnline(page);
			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.id === clientId)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);

			// Replay the byte-identical create directly against the backend.
			const res = await fetch(`${BACKEND_URL}/todo.v1.TodoService/CreateTodo`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: clientId, title }),
			});
			expect(res.status).toBe(HTTP_OK);

			// Exactly ONE row with this id survives the double flush.
			const matches = (await listBackendTodos()).filter((t) => t.id === clientId);
			expect(matches).toHaveLength(1);
			expect(matches[0]?.title).toBe(title);
		} finally {
			if (clientId !== undefined) {
				const leftover = (await listBackendTodos()).find((t) => t.id === clientId);
				if (leftover) await deleteBackendTodo(leftover.id);
			}
		}
	});

	test("stale indicator: visible data is kept (not replaced) when a background refetch errors", async ({
		page,
	}) => {
		// 1w9.3 review F2: a failed background refetch on already-visible data must
		// NOT replace the list with an error screen — render the data with a stale
		// indicator instead (data && isError path).
		const seeded = await createBackendTodo(`E2E_STALE_${String(Date.now())}`);
		try {
			await page.goto("/todos");
			await waitForHydration(page);
			const row = page.locator("main ul li", { hasText: seeded.title });
			await expect(row).toBeVisible();

			// Break every subsequent ListTodos so the next background refetch errors.
			await page.route("**/todo.v1.TodoService/ListTodos**", (route) => route.abort());

			// Toggle the row → its onSuccess invalidates the list → the refetch errors
			// (status → 'error') while the query KEEPS its data.
			await row.locator('[data-part="control"]').click();

			// The list stays visible, now with the stale indicator — never the
			// "Failed to load todos." error screen.
			await expect(page.getByText("Showing saved data", { exact: false })).toBeVisible();
			await expect(row).toBeVisible();
			await expect(page.getByText("Failed to load todos.")).toHaveCount(0);
		} finally {
			await deleteBackendTodo(seeded.id);
		}
	});
});
