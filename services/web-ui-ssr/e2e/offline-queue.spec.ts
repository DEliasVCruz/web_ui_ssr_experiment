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
// Cadence for the per-document `offline` re-dispatch in the multi-reload survival test.
const OFFLINE_EVENT_INTERVAL_MS = 15;

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

/** Reads the raw persisted paused-mutations JSON string from IndexedDB (or undefined). */
function readPersistedQueue(page: Page): Promise<string | undefined> {
	return page.evaluate(
		() =>
			new Promise<string | undefined>((resolve) => {
				void indexedDB.databases().then((dbs) => {
					if (!dbs.some((d) => d.name === "keyval-store")) {
						resolve(undefined);
						return;
					}
					const req = indexedDB.open("keyval-store");
					req.onerror = () => {
						resolve(undefined);
					};
					req.onsuccess = () => {
						const db = req.result;
						if (!db.objectStoreNames.contains("keyval")) {
							db.close();
							resolve(undefined);
							return;
						}
						const r = db
							.transaction("keyval", "readonly")
							.objectStore("keyval")
							.get("web-ui-paused-mutations");
						r.onerror = () => {
							db.close();
							resolve(undefined);
						};
						r.onsuccess = () => {
							const raw = r.result as string | undefined;
							db.close();
							resolve(typeof raw === "string" ? raw : undefined);
						};
					};
				});
			}),
	);
}

/** Polls until the persisted queue contains a mutation whose key includes `keyName`. */
async function waitForQueueContains(page: Page, keyName: string): Promise<void> {
	await expect
		.poll(() => readPersistedQueue(page).then((raw) => raw?.includes(keyName) ?? false), {
			timeout: FLUSH_TIMEOUT_MS,
		})
		.toBe(true);
}

/** Polls until the persisted queue entry is gone (no queued mutation remains). */
async function waitForQueueGone(page: Page): Promise<void> {
	await expect
		.poll(() => readPersistedQueue(page).then((raw) => raw === undefined), {
			timeout: FLUSH_TIMEOUT_MS,
		})
		.toBe(true);
}

/** Polls until a queued CREATE has been persisted to IndexedDB. */
async function waitForQueuePersisted(page: Page): Promise<void> {
	await waitForQueueContains(page, "createTodo");
}

/**
 * Polls until the persisted queue holds no queued CREATE — either the whole entry is
 * gone (persist() del's it when nothing remains) or it no longer contains a createTodo.
 */
async function waitForQueueEmpty(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				readPersistedQueue(page).then((raw) => raw === undefined || !raw.includes("createTodo")),
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

	test("offline DELETE replays on reconnect — the row is removed on the server", async ({
		page,
		context,
	}) => {
		// deleteTodo is queue-registered (mutation-defaults.ts, DELETE_TODO_KEY) but was
		// never exercised offline end-to-end. Delete an existing row while offline (the
		// optimistic removal takes it out of the list immediately, the DeleteTodo mutation
		// pauses), reconnect, and prove the queued delete flushes and the server drops it.
		const seeded = await createBackendTodo(`E2E_Q_DELETE_${String(Date.now())}`);
		let removed = false;
		try {
			await page.goto("/todos");
			await waitForHydration(page);
			const row = page.locator("main ul li", { hasText: seeded.title });
			await expect(row).toBeVisible();

			await context.setOffline(true);
			await expect(page.getByText("You’re offline.", { exact: false })).toBeVisible();

			// Delete via the confirm dialog (list Delete → dialog Delete).
			await row.getByRole("button", { name: "Delete" }).click();
			await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
			await expect(page.locator("main ul li", { hasText: seeded.title })).toHaveCount(0);

			// Queued, not sent: the row still exists on the server, and the delete is
			// persisted to IndexedDB so it would survive a reload.
			expect((await listBackendTodos()).some((t) => t.id === seeded.id)).toBe(true);
			await waitForQueueContains(page, "deleteTodo");

			// ── Reconnect: the queued delete flushes ──────────────────────────────────
			await context.setOffline(false);
			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.id === seeded.id)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(false);
			removed = true;

			// The row stays gone in the UI (the reconciliation refetch confirms deletion),
			// and the queue entry is cleared on terminal success.
			await expect(page.locator("main ul li", { hasText: seeded.title })).toHaveCount(0);
			await waitForQueueGone(page);
		} finally {
			if (!removed) {
				const leftover = (await listBackendTodos()).find((t) => t.id === seeded.id);
				if (leftover) await deleteBackendTodo(seeded.id);
			}
		}
	});

	test("terminal flush failure surfaces an error toast, drops the write, and does not wedge the queue (F7)", async ({
		page,
	}) => {
		// F7 (deferred from 1w9.4). A RESTORED queued mutation replays through the mutation
		// DEFAULTS only (its component isn't mounted), and those had no onError — so a
		// GENUINE non-network server rejection on flush dropped the write SILENTLY. The
		// honest rejection path: queue an edit offline against a todo that is deleted
		// server-side out of band, then reload so the edit replays as a restored mutation →
		// its UpdateTodo 404s (NOT_FOUND) → terminal (retry 0). We ALSO queue a create AFTER
		// the doomed edit to prove the terminal error does not wedge the queue scope: the
		// later create must still flush. Assertions: (a) the established error toast shows,
		// identifying the failed action; (b) no ghost row for the deleted id; (c) the queue
		// drains empty; (d) the subsequent create lands (queue not wedged).
		const stamp = String(Date.now());
		const doomed = await createBackendTodo(`E2E_Q_DOOMED_${stamp}`, "will be deleted");
		const followTitle = `E2E_Q_FOLLOW_${stamp}`;
		let followId: string | undefined;
		let doomedCleaned = false;
		try {
			await page.goto("/todos");
			await waitForHydration(page);

			// Prime the doomed todo's detail cache (so it can be edited offline).
			await page.getByRole("link", { name: doomed.title, exact: true }).click();
			await expect(page).toHaveURL(new RegExp(`/todos/${doomed.id}$`));
			await expect(page.getByRole("heading", { name: doomed.title })).toBeVisible();

			await goOffline(page);

			// Queue the doomed EDIT first (so it replays before the follow-up create).
			await page.getByRole("button", { name: "Edit details" }).click();
			await page.getByPlaceholder("Add details…").fill(`edited-${stamp}`);
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await waitForQueueContains(page, "editTodoDetails");

			// Then queue a follow-up CREATE (client nav back to the list — no reload, so both
			// queued mutations survive in IndexedDB).
			await page.getByRole("link", { name: "Todos" }).first().click();
			await expect(page).toHaveURL(/\/todos$/);
			await page.locator(ADD_INPUT_SELECTOR).fill(followTitle);
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await expect(page.locator("main ul li", { hasText: followTitle })).toBeVisible();
			followId = await rowClientId(page, followTitle);
			await waitForQueueContains(page, "createTodo");

			// Out-of-band: delete the doomed todo on the server so the queued edit will 404.
			await deleteBackendTodo(doomed.id);
			doomedCleaned = true;

			// ── Reload: both mutations replay as RESTORED (defaults-only) and resume ────
			// The edit flushes first → UpdateTodo 404 (NOT_FOUND) → terminal error → the
			// default onError fires (toast). The create then flushes and lands.
			await page.goto("/todos");
			await waitForHydration(page);

			// (a) The established error toast surfaces, identifying the failed action.
			await expect(page.getByText("Couldn’t save todo details").first()).toBeVisible();

			// (d) Queue not wedged: the follow-up create still flushed to the server.
			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.id === followId)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);

			// (b) No ghost: the deleted id has no row in the list or on the server.
			await expect(page.locator("main ul li", { hasText: doomed.title })).toHaveCount(0);
			expect((await listBackendTodos()).some((t) => t.id === doomed.id)).toBe(false);

			// (c) The queue drains empty — the dropped edit is not left behind to retry.
			await page.waitForLoadState("networkidle");
			await waitForQueueGone(page);
		} finally {
			if (!doomedCleaned) {
				const leftover = (await listBackendTodos()).find((t) => t.id === doomed.id);
				if (leftover) await deleteBackendTodo(doomed.id);
			}
			if (followId !== undefined) {
				const leftover = (await listBackendTodos()).find((t) => t.id === followId);
				if (leftover) await deleteBackendTodo(followId);
			}
		}
	});

	test("the queued write survives MULTIPLE offline reloads and flushes exactly once on reconnect", async ({
		page,
	}) => {
		// onlineManager resets to online on every fresh document and flips only on
		// connectivity EVENTS (it ignores navigator.onLine — see the file header). So to
		// keep a restored create PAUSED across reloads (rather than flushing on the first
		// reload, as the single-reload survival test above deliberately does), we drive a
		// short burst of `offline` events at the start of EACH document — the same
		// event-model this suite already uses (goOffline), just re-applied per document. The
		// network itself stays up, so the reloads still work; only the app's connectivity
		// belief is forced offline. The persisted queue must survive BOTH reloads and then,
		// on a single reconnect, fire CreateTodo EXACTLY ONCE (client UUIDv7 id ⇒ no
		// duplicate row even if a reload had re-sent it).
		const title = `E2E_MULTIRELOAD_${String(Date.now())}`;
		let clientId: string | undefined;
		let createCount = 0;
		// page.route + addInitScript both persist across the reloads below.
		await page.route("**/todo.v1.TodoService/CreateTodo", async (route) => {
			if (route.request().method() === "POST") createCount += 1;
			await route.continue();
		});
		// Re-dispatch `offline` on a tight timer at the start of EACH document, gated by a
		// window flag the test flips to reconnect. This keeps onlineManager offline through
		// the startup restore+resume so the restored create stays paused across reloads;
		// clearing the flag lets the timer stop and we then dispatch a single `online`.
		await page.addInitScript((intervalMs) => {
			const w = window as unknown as { __forceOffline?: boolean };
			w.__forceOffline = true;
			const iv = setInterval(() => {
				if (w.__forceOffline !== true) {
					clearInterval(iv);
					return;
				}
				window.dispatchEvent(new Event("offline"));
			}, intervalMs);
		}, OFFLINE_EVENT_INTERVAL_MS);
		try {
			await page.goto("/todos");
			await waitForHydration(page);
			await expect(page.getByText("You’re offline.", { exact: false })).toBeVisible();

			await page.locator(ADD_INPUT_SELECTOR).fill(title);
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await expect(page.locator("main ul li", { hasText: title })).toBeVisible();
			clientId = await rowClientId(page, title);
			await waitForQueueContains(page, "createTodo");
			expect(createCount).toBe(0); // paused: never fired while (event-)offline

			// ── Reload #1 (still forced offline) ──────────────────────────────────────
			await page.goto("/todos");
			await waitForHydration(page);
			await expect(page.getByText("You’re offline.", { exact: false })).toBeVisible();
			await waitForQueueContains(page, "createTodo"); // survived reload #1
			expect(createCount).toBe(0);

			// ── Reload #2 (still forced offline) ──────────────────────────────────────
			await page.goto("/todos");
			await waitForHydration(page);
			await expect(page.getByText("You’re offline.", { exact: false })).toBeVisible();
			await waitForQueueContains(page, "createTodo"); // survived reload #2
			expect(createCount).toBe(0);

			// ── Reconnect: one flush ──────────────────────────────────────────────────
			// Clear the offline flag (stops the re-dispatch timer) and flip online once.
			await page.evaluate(() => {
				const w = window as unknown as { __forceOffline?: boolean };
				w.__forceOffline = false;
				window.dispatchEvent(new Event("online"));
			});

			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.id === clientId)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);
			expect((await listBackendTodos()).filter((t) => t.id === clientId)).toHaveLength(1);
			// Let any erroneous per-reload resend surface, then assert exactly one CreateTodo.
			await page.waitForLoadState("networkidle");
			expect(createCount).toBe(1);
			await waitForQueueGone(page);
		} finally {
			if (clientId !== undefined) {
				const leftover = (await listBackendTodos()).find((t) => t.id === clientId);
				if (leftover) await deleteBackendTodo(clientId);
			}
		}
	});

	test("multi-hop offline SPA navigation renders every hop from cache — no blank frames", async ({
		page,
		context,
	}) => {
		// Client-side navigation across several hops while offline must paint each route
		// from cache with no blank frame or crash. Prime the caches online (list is
		// SSR-hydrated; the detail is fetched + persisted on a client nav), then block every
		// TodoService RPC at the network layer and hop home → todos → detail → back,
		// asserting rendered content at each hop. SPA navigations issue no document request,
		// so the only thing answering is the in-memory / persisted query cache.
		const seeded = await createBackendTodo(`E2E_NAV_${String(Date.now())}`, "nav details");
		try {
			await page.goto("/todos", { waitUntil: "networkidle" });
			await waitForHydration(page);
			// Prime the detail cache via a client nav, then park on Home.
			await page.getByRole("link", { name: seeded.title, exact: true }).click();
			await expect(page).toHaveURL(new RegExp(`/todos/${seeded.id}$`));
			await expect(page.getByRole("heading", { name: seeded.title })).toBeVisible();
			await expect(page.getByText("nav details")).toBeVisible();
			await page.getByRole("link", { name: "Home" }).click();
			await expect(page).toHaveURL(/\/$/);
			await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

			// ── Go offline at the RPC layer (documents unaffected — nav is client-side) ─
			const attemptedRpcs: string[] = [];
			await context.route("**/todo.v1.TodoService/**", (route) => {
				attemptedRpcs.push(route.request().url());
				return route.abort();
			});

			// Hop 1: Home → Todos (list from cache).
			await page.getByRole("link", { name: "Todos" }).first().click();
			await expect(page).toHaveURL(/\/todos$/);
			await expect(page.getByRole("heading", { name: "Todos", exact: true })).toBeVisible();
			await expect(page.locator("main ul li", { hasText: seeded.title })).toBeVisible();

			// Hop 2: Todos → detail (from persisted cache).
			await page.getByRole("link", { name: seeded.title, exact: true }).click();
			await expect(page).toHaveURL(new RegExp(`/todos/${seeded.id}$`));
			await expect(page.getByRole("heading", { name: seeded.title })).toBeVisible();
			await expect(page.getByText("nav details")).toBeVisible();

			// Hop 3: back to the list (browser back = client-side), still from cache.
			await page.goBack();
			await expect(page).toHaveURL(/\/todos$/);
			await expect(page.locator("main ul li", { hasText: seeded.title })).toBeVisible();

			// Hop 4: back to Home.
			await page.getByRole("link", { name: "Home" }).click();
			await expect(page).toHaveURL(/\/$/);
			await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

			// Every hop was served from cache: the freshness window (staleTime) meant the
			// loaders never even attempted a refetch, so no TodoService RPC was aborted.
			expect(attemptedRpcs).toEqual([]);
		} finally {
			await deleteBackendTodo(seeded.id);
		}
	});

	test("concurrent cross-todo offline mutations all flush on reconnect — final server state is correct", async ({
		page,
		context,
	}) => {
		// A mixed batch of offline writes across DIFFERENT todos (create + toggle + edit +
		// delete) must all flush correctly on reconnect, replayed serially by the queue-wide
		// scope, leaving the server in the exact expected final state.
		const stamp = String(Date.now());
		const toToggle = await createBackendTodo(`E2E_MIX_TOGGLE_${stamp}`);
		const toDelete = await createBackendTodo(`E2E_MIX_DELETE_${stamp}`);
		const toEdit = await createBackendTodo(`E2E_MIX_EDIT_${stamp}`);
		const createdTitle = `E2E_MIX_CREATE_${stamp}`;
		const editedDetails = `mix-details-${stamp}`;
		const seededIds = [toToggle.id, toDelete.id, toEdit.id];
		let createdId: string | undefined;
		try {
			await page.goto("/todos");
			await waitForHydration(page);
			// Prime the edit target's detail cache, then return to the list.
			await page.getByRole("link", { name: toEdit.title, exact: true }).click();
			await expect(page).toHaveURL(new RegExp(`/todos/${toEdit.id}$`));
			await expect(page.getByRole("heading", { name: toEdit.title })).toBeVisible();
			await page.getByRole("link", { name: "Todos" }).first().click();
			await expect(page).toHaveURL(/\/todos$/);
			await waitForHydration(page);

			await context.setOffline(true);
			await expect(page.getByText("You’re offline.", { exact: false })).toBeVisible();

			// CREATE a new todo.
			await page.locator(ADD_INPUT_SELECTOR).fill(createdTitle);
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await expect(page.locator("main ul li", { hasText: createdTitle })).toBeVisible();
			createdId = await rowClientId(page, createdTitle);

			// TOGGLE one existing row.
			const toggleRow = page.locator("main ul li", { hasText: toToggle.title });
			await toggleRow.locator('[data-part="control"]').click();
			await expect(toggleRow.locator('input[type="checkbox"]')).toBeChecked();

			// DELETE another existing row.
			const delRow = page.locator("main ul li", { hasText: toDelete.title });
			await delRow.getByRole("button", { name: "Delete" }).click();
			await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
			await expect(page.locator("main ul li", { hasText: toDelete.title })).toHaveCount(0);

			// EDIT a third row's details (client nav to its cached detail).
			const editRow = page.locator("main ul li", { hasText: toEdit.title });
			await editRow.locator("a").click();
			await expect(page).toHaveURL(new RegExp(`/todos/${toEdit.id}$`));
			await page.getByRole("button", { name: "Edit details" }).click();
			await page.getByPlaceholder("Add details…").fill(editedDetails);
			await page.getByRole("button", { name: "Save", exact: true }).click();

			// Nothing has hit the server yet — the whole batch is queued.
			expect((await listBackendTodos()).some((t) => t.title === createdTitle)).toBe(false);
			expect((await getBackendTodo(toToggle.id)).completed ?? false).toBe(false);
			expect((await listBackendTodos()).some((t) => t.id === toDelete.id)).toBe(true);

			// ── Reconnect: the whole queue flushes ────────────────────────────────────
			await context.setOffline(false);

			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.title === createdTitle)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);
			await expect
				.poll(() => getBackendTodo(toToggle.id).then((t) => t.completed ?? false), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(true);
			await expect
				.poll(() => listBackendTodos().then((ts) => ts.some((t) => t.id === toDelete.id)), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(false);
			await expect
				.poll(() => getBackendTodo(toEdit.id).then((t) => t.details ?? ""), {
					timeout: FLUSH_TIMEOUT_MS,
				})
				.toBe(editedDetails);
		} finally {
			const remaining = await listBackendTodos();
			const ids = createdId === undefined ? seededIds : [...seededIds, createdId];
			await Promise.all(
				ids.filter((id) => remaining.some((t) => t.id === id)).map((id) => deleteBackendTodo(id)),
			);
		}
	});
});
