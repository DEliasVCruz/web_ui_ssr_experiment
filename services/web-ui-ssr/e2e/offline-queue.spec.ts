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
// Artificial CreateTodo latency for the scope-serialization proof: long enough that
// a NON-serialized edit would provably fire (and 404) before the create lands.
const CREATE_DELAY_MS = 1500;

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

/** Polls until the paused-mutation queue entry is ABSENT from IndexedDB. */
async function waitForQueueEmpty(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						new Promise<boolean>((resolve) => {
							void indexedDB.databases().then((dbs) => {
								if (!dbs.some((d) => d.name === "keyval-store")) {
									resolve(true);
									return;
								}
								const req = indexedDB.open("keyval-store");
								req.onerror = () => {
									resolve(true);
								};
								req.onsuccess = () => {
									const db = req.result;
									if (!db.objectStoreNames.contains("keyval")) {
										db.close();
										resolve(true);
										return;
									}
									const r = db
										.transaction("keyval", "readonly")
										.objectStore("keyval")
										.get("web-ui-paused-mutations");
									r.onerror = () => {
										db.close();
										resolve(true);
									};
									r.onsuccess = () => {
										const raw = r.result as string | undefined;
										db.close();
										// Empty iff the key is gone entirely (persist() del's it when no
										// queued mutation remains) or holds no createTodo.
										resolve(raw === undefined || !raw.includes("createTodo"));
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
		// Keep-until-success (review F2) makes replay genuinely at-least-once — a write
		// survives in IndexedDB until it terminally succeeds, so a crash mid-flush replays
		// it — and the client id makes that replay safe. Queue a create offline, flush it,
		// then RE-SEND the identical id+title (simulating a double flush / crash-mid-flush
		// replay). First-write-wins → still one row, one id.
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

			// Toggle the row → its onSettled invalidates the list → the refetch errors
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

	test("a single toggle triggers exactly one ListTodos reconciliation refetch (F3: no double-invalidate)", async ({
		page,
	}) => {
		// F3: the toggle supplies its reconciliation as an INLINE onSettled that
		// OVERRIDES the TOGGLE default's onSettled. Were it an onSuccess (the pre-fix
		// shape), it would run IN ADDITION to the default onSettled — query-core awaits
		// onSuccess then onSettled sequentially, so the list would refetch TWICE per
		// toggle (checkbox disabled ~2× RTT). Assert exactly one ListTodos POST follows
		// a single toggle.
		const seeded = await createBackendTodo(`E2E_ONEINVAL_${String(Date.now())}`);
		const listCalls: string[] = [];
		try {
			// networkidle so the initial load's fetches are fully settled before counting.
			await page.goto("/todos", { waitUntil: "networkidle" });
			await waitForHydration(page);
			const row = page.locator("main ul li", { hasText: seeded.title });
			await expect(row).toBeVisible();
			const checkbox = row.locator('input[type="checkbox"]');

			// Count ListTodos requests from here on (post initial-load). NB ListTodos is
			// NO_SIDE_EFFECTS and the client transport uses useHttpGet, so the
			// reconciliation refetch is a GET — match on URL, not method.
			page.on("request", (req) => {
				if (req.url().includes("/todo.v1.TodoService/ListTodos")) {
					listCalls.push(req.url());
				}
			});

			await row.locator('[data-part="control"]').click();
			await expect(checkbox).toBeChecked(); // optimistic reflection (disabled while pending)
			// The toggle keeps the mutation pending — and the checkbox DISABLED — until
			// EVERY reconciliation refetch it fires has landed (keep-pending). Waiting for
			// the checkbox to re-enable is therefore an exact "fully settled" signal that
			// spans all refetch rounds: with the fix that is one ListTodos POST; with the
			// pre-fix onSuccess+default-onSettled overlap it would be two.
			await expect(checkbox).toBeEnabled();

			expect(listCalls).toHaveLength(1);
		} finally {
			await deleteBackendTodo(seeded.id);
		}
	});

	test("post-flush reload: a flushed create is removed from the queue and never re-sent", async ({
		page,
	}) => {
		// Keep-until-success's other edge (review F4, pairs with F2): once a queued
		// create terminally SUCCEEDS, its IndexedDB entry must be REMOVED — not left to
		// resurrect as a duplicate on the next load. Queue a create offline, flush it on
		// reconnect, then reload: the queue entry is gone and NO second CreateTodo fires
		// (if keep-until-success were mis-implemented as keep-forever, the reload would
		// restore + resume the survivor and a second CreateTodo would go out).
		const title = `E2E_NORESURRECT_${String(Date.now())}`;
		let clientId: string | undefined;
		let createCount = 0;
		// page.route survives reloads, so this counter spans the whole test — including
		// the post-reload startup resume.
		await page.route("**/todo.v1.TodoService/CreateTodo", async (route) => {
			if (route.request().method() === "POST") createCount += 1;
			await route.continue();
		});
		try {
			await page.goto("/todos");
			await waitForHydration(page);

			await goOffline(page);
			await page.locator(ADD_INPUT_SELECTOR).fill(title);
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await expect(page.locator("main ul li", { hasText: title })).toBeVisible();
			clientId = await rowClientId(page, title);

			// Queued (persisted), not yet sent.
			expect((await listBackendTodos()).some((t) => t.title === title)).toBe(false);
			await waitForQueuePersisted(page);
			expect(createCount).toBe(0);

			// ── Reconnect: flush ─────────────────────────────────────────────────────
			await goOnline(page);
			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.id === clientId)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);
			expect(createCount).toBe(1); // flushed exactly once

			// keep-until-success: on terminal success the entry is REMOVED.
			await waitForQueueEmpty(page);

			// ── Reload: nothing to restore, nothing to resume ────────────────────────
			await page.goto("/todos");
			await waitForHydration(page);
			// networkidle gives the startup restore+resume its full chance to (not) fire
			// a resurrected CreateTodo — a replay RPC would keep the network busy and be
			// counted below.
			await page.waitForLoadState("networkidle");

			// No resurrection: the queue stays empty, the create is NOT re-sent, and the
			// server still holds exactly one row for this id.
			await waitForQueueEmpty(page);
			expect(createCount).toBe(1);
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

	test("offline create then edit-details on the same new todo replay serialized — create lands before the edit", async ({
		page,
	}) => {
		// F1 scope proof. Queue a CREATE, deep-link its cache-seeded detail, and queue an
		// EDIT-DETAILS on the SAME new id. On reconnect resumePausedMutations is Promise
		// .all (concurrent), so WITHOUT a shared queue scope the edit races the create and
		// hits NOT_FOUND. The CreateTodo RPC is delayed to make that race deterministic:
		// with the scope, query-core's canRun holds the edit until the (delayed) create
		// settles, so the edit then updates a row that exists; without it, the edit fires
		// immediately, 404s, and the details are never persisted. This also proves a
		// RESTORED/rehydrated mutation inherits the scope from the defaults (both replay
		// paths run through the same defaulted options).
		const title = `E2E_SCOPE_${String(Date.now())}`;
		const details = `scoped-details-${String(Date.now())}`;
		let clientId: string | undefined;
		// Delay CreateTodo so a non-serialized edit would provably win the race.
		await page.route("**/todo.v1.TodoService/CreateTodo", async (route) => {
			if (route.request().method() === "POST") {
				await new Promise((resolve) => setTimeout(resolve, CREATE_DELAY_MS));
			}
			await route.continue();
		});
		try {
			await page.goto("/todos");
			await waitForHydration(page);

			await goOffline(page);
			await page.locator(ADD_INPUT_SELECTOR).fill(title);
			await page.getByRole("button", { name: "Add", exact: true }).click();
			const createdRow = page.locator("main ul li", { hasText: title });
			await expect(createdRow).toBeVisible();
			clientId = await rowClientId(page, title);

			// The optimistic create row carries `data-pending` (pointer-events:none), so a
			// real click can't land on its Link — dispatch the click straight at the anchor
			// to drive the router's client-side navigation (no reload, so the queued create
			// mutation and the seeded detail cache both survive).
			await createdRow.locator("a").dispatchEvent("click");
			await expect(page).toHaveURL(new RegExp(`/todos/${clientId}$`));

			// Queue the edit-details on the new id (served from the seeded detail cache —
			// no RPC, so it works offline).
			await page.getByRole("button", { name: "Edit details" }).click();
			await page.getByPlaceholder("Add details…").fill(details);
			await page.getByRole("button", { name: "Save", exact: true }).click();

			// Nothing sent yet: both writes are queued.
			expect((await listBackendTodos()).some((t) => t.id === clientId)).toBe(false);

			// ── Reconnect: create then edit flush in scope order ─────────────────────
			await goOnline(page);
			// The create lands…
			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.id === clientId)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);
			// …and the SERIALIZED edit then persists the details. Without the queue scope
			// the edit would have raced ahead of the create, 404'd, and left details unset.
			await expect
				.poll(() => getBackendTodo(clientId ?? "").then((t) => t.details ?? ""), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(details);
		} finally {
			if (clientId !== undefined) {
				const leftover = (await listBackendTodos()).find((t) => t.id === clientId);
				if (leftover) await deleteBackendTodo(leftover.id);
			}
		}
	});

	test("the reload-survival flush fires NO view transition (background reconciliation, not a user action)", async ({
		page,
	}) => {
		// A queue flush is BACKGROUND reconciliation, not a user action: query-core
		// never re-runs onMutate on a RESTORED mutation (so the VT-wrapped optimistic
		// append is skipped — see todos.index.tsx), and the replay reconciliation is
		// settleInvalidate, deliberately NOT withViewTransition (mutation-defaults.ts).
		// So a reload-survival flush must fire ZERO document.startViewTransition calls:
		// the survivor's row appears via a plain refetch, with no transition. (The LIVE
		// optimistic create DOES wrap its append in a VT — view-transitions.spec.ts.)
		const title = `E2E_VTFREE_${String(Date.now())}`;
		let clientId: string | undefined;
		// Spy on startViewTransition before any page script, on EVERY load/navigation
		// (addInitScript persists across the reload below); counts onto window.__vtCalls.
		await page.addInitScript(() => {
			const w = window as unknown as { __vtCalls: number };
			w.__vtCalls = 0;
			const proto = Document.prototype as Document & {
				startViewTransition?: Document["startViewTransition"];
			};
			const original = proto.startViewTransition;
			if (typeof original === "function") {
				proto.startViewTransition = function patched(
					this: Document,
					...args: Parameters<Document["startViewTransition"]>
				): ViewTransition {
					w.__vtCalls += 1;
					return original.apply(this, args);
				};
			}
		});
		try {
			await page.goto("/todos");
			await waitForHydration(page);

			await goOffline(page);
			await page.locator(ADD_INPUT_SELECTOR).fill(title);
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await expect(page.locator("main ul li", { hasText: title })).toBeVisible();
			clientId = await rowClientId(page, title);
			await waitForQueuePersisted(page);

			// ── Reload: fresh document; the restored create resumes+flushes at startup ─
			await page.goto("/todos");
			await waitForHydration(page);

			// The flush lands the survivor on the server and the reconciliation refetch
			// brings the row into the rendered list…
			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.id === clientId)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);
			await expect(page.locator("main ul li", { hasText: title })).toBeVisible();
			// …give any stray transition its full chance to fire, then assert none did.
			await page.waitForLoadState("networkidle");
			expect(
				await page.evaluate(() => (window as unknown as { __vtCalls: number }).__vtCalls),
			).toBe(0);
		} finally {
			const leftover = (await listBackendTodos()).find((t) => t.title === title);
			if (leftover) await deleteBackendTodo(leftover.id);
		}
	});

	test("flush emits EXACTLY ONE browser wide event per queued action (offline onMutate emits none)", async ({
		page,
		context,
	}) => {
		// The offline onMutate emits NOTHING (the action is queued, not done); the one
		// and only wide event for a queued action is emitted at REPLAY, flagged
		// offline_queued (browser-events.ts). So flushing a single queued create must
		// yield EXACTLY ONE create_todo event — never zero (event lost) and never two
		// (the action double-counted in observability). Test 1 above proves the flag +
		// trace correlation with `.some()`; this pins the COUNT.
		const title = `E2E_ONEEVENT_${String(Date.now())}`;
		let clientId: string | undefined;
		const createEvents: BrowserWideEventLine[] = [];
		page.on("console", (msg) => {
			const text = msg.text();
			if (!text.startsWith("{")) return;
			try {
				const parsed = JSON.parse(text) as BrowserWideEventLine;
				if (parsed.component === "web-ui-browser" && parsed.action === "create_todo") {
					createEvents.push(parsed);
				}
			} catch {
				// not one of our JSON wide-event lines
			}
		});
		try {
			await page.goto("/todos");
			await waitForHydration(page);

			// Real offline so the enqueue is honestly captured as offline_queued.
			await context.setOffline(true);
			await page.locator(ADD_INPUT_SELECTOR).fill(title);
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await expect(page.locator("main ul li", { hasText: title })).toBeVisible();
			clientId = await rowClientId(page, title);

			// Queued, not sent: the offline onMutate emitted NO wide event.
			expect(createEvents).toHaveLength(0);

			// ── Reconnect: flush ──────────────────────────────────────────────────────
			await context.setOffline(false);
			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.id === clientId)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);

			// Exactly one create_todo wide event, emitted at replay, flagged offline_queued.
			await expect.poll(() => createEvents.length, { timeout: FLUSH_TIMEOUT_MS }).toBe(1);
			// Let any erroneous second emission surface, then re-assert exactly one.
			await page.waitForLoadState("networkidle");
			expect(createEvents).toHaveLength(1);
			expect(createEvents[0]?.offline_queued).toBe(true);
		} finally {
			if (clientId !== undefined) {
				const leftover = (await listBackendTodos()).find((t) => t.id === clientId);
				if (leftover) await deleteBackendTodo(leftover.id);
			}
		}
	});
});
