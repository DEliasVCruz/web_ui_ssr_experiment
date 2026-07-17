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

// Optimistic updates (a4a.3 + fix pass). These specs prove the UI stays snappy
// under latency AND never de-optimizes: an optimistic CREATE row renders before
// the server confirms and persists through the settle refetch with no vanish or
// duplicate window; a TOGGLE holds its optimistic state until the refetched
// truth lands (no bounce-back); failed create/delete/edit all roll back visibly
// and surface the shared error toast; the delete path's cancelQueries guards the
// refetch race (gate-deterministic, teeth-proven); and toggling a todo WITH
// details never clobbers the details. Server interactions are shaped with
// Playwright route interception (gate / abort / hang) — gates observe real
// requests rather than racing fixed delays.

// Bounded in-renderer slack applied AFTER a gate-observed network event (a
// delivered response, a surfaced toast): the remaining work is renderer-internal
// microtasks (parse → cache write → re-render), not a network race, so a small
// constant is deterministic where a fixed pre-delay would not be.
const SETTLE_SLACK_MS = 300;

/**
 * Detail-page hydration probe (duplicated from details.spec.ts, which keeps it
 * file-local). Waits until Solid has attached its delegated click handler
 * (`$$click`) to the "Edit details" button — the authoritative "this page is
 * interactive" signal for the detail route.
 */
async function waitForDetailHydration(page: Page): Promise<void> {
	const editButton = page.getByRole("button", { name: "Edit details" });
	await expect(editButton).toBeVisible();
	await expect
		.poll(() =>
			editButton.evaluate(
				(el) => typeof (el as Element & { $$click?: unknown }).$$click === "function",
			),
		)
		.toBe(true);
}

test.describe("optimistic updates", () => {
	test("an optimistic create row renders before the server confirms", async ({ page }) => {
		await page.goto("/todos");
		await waitForHydration(page);

		// Hold the CreateTodo response open so the optimistic (pending) row is
		// observable while the RPC is still in flight.
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/todo.v1.TodoService/CreateTodo", async (route) => {
			await gate;
			await route.continue();
		});

		const title = `E2E_OPT_CREATE_${String(Date.now())}`;
		await page.locator(ADD_INPUT_SELECTOR).fill(title);
		await page.getByRole("button", { name: "Add", exact: true }).click();

		// The optimistic temp row is present — dimmed via data-pending — BEFORE the
		// server has answered (the RPC is still gated).
		const pendingRow = page.locator("main ul li[data-pending]", { hasText: title });
		await expect(pendingRow).toBeVisible();

		// Release the server; the temp row reconciles to a confirmed row
		// (data-pending drops once the settle refetch swaps in the real row).
		release();
		await expect(page.locator("main ul li[data-pending]", { hasText: title })).toHaveCount(0);
		await expect(page.locator("main ul li", { hasText: title })).toBeVisible();

		// Self-clean: find the confirmed todo on the backend and remove it.
		const created = (await listBackendTodos()).find((t) => t.title === title);
		if (created) await deleteBackendTodo(created.id);
	});

	test("the created row persists through the settle refetch — no vanish, no duplicate", async ({
		page,
	}) => {
		// Review F1/F3 regression guard. The old mutation-state create dropped its
		// pending row the moment the mutation flipped to success — a visible vanish
		// for the full settle-refetch RTT — and could briefly show the row twice if
		// a refetch landed while a post-commit create was still pending. With the
		// cache-write pattern the temp row lives in the list cache itself, so it
		// can neither vanish (nothing is keyed off mutation status) nor duplicate
		// (a landing refetch atomically replaces the whole array, temp → real).
		//
		// Gating: hold ALL client ListTodos (the settle refetch) open. After the
		// CreateTodo response is OBSERVED — the exact moment the old bug dropped
		// the row — the row must still be present, exactly once, still pending.
		await page.goto("/todos");
		await waitForHydration(page);

		let releaseList = (): void => {};
		const listGate = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		await page.route("**/todo.v1.TodoService/ListTodos**", async (route) => {
			await listGate;
			await route.continue();
		});

		const title = `E2E_OPT_NOVANISH_${String(Date.now())}`;
		const createResponse = page.waitForResponse((resp) =>
			resp.url().includes("/todo.v1.TodoService/CreateTodo"),
		);
		await page.locator(ADD_INPUT_SELECTOR).fill(title);
		await page.getByRole("button", { name: "Add", exact: true }).click();

		const row = page.locator("main ul li", { hasText: title });
		await expect(row).toBeVisible();

		// Server confirmed (response fully delivered) — the old bug's vanish window
		// opened HERE and lasted until the settle refetch landed.
		const resp = await createResponse;
		await resp.finished();
		await page.waitForTimeout(SETTLE_SLACK_MS);

		// No vanish: still exactly one row, still pending (the settle refetch is
		// gated, so reconciliation has provably not happened yet).
		await expect(row).toHaveCount(1);
		await expect(page.locator("main ul li[data-pending]", { hasText: title })).toHaveCount(1);

		// Release the settle refetch: temp → real swap, still exactly one row (no
		// duplicate window), pending styling drops.
		releaseList();
		await expect(page.locator("main ul li[data-pending]", { hasText: title })).toHaveCount(0);
		await expect(row).toHaveCount(1);

		const created = (await listBackendTodos()).find((t) => t.title === title);
		if (created) await deleteBackendTodo(created.id);
	});

	test("a failed create rolls back the optimistic row and surfaces an error", async ({ page }) => {
		await page.goto("/todos");
		await waitForHydration(page);

		// Force CreateTodo to fail so the mutation's onError path runs.
		await page.route("**/todo.v1.TodoService/CreateTodo", (route) => route.abort());

		const title = `E2E_OPT_CREATE_FAIL_${String(Date.now())}`;
		await page.locator(ADD_INPUT_SELECTOR).fill(title);
		await page.getByRole("button", { name: "Add", exact: true }).click();

		// Rollback: the onError snapshot restore removes the optimistic temp row
		// from the list cache, and the error is surfaced.
		await expect(page.getByText("Failed to add todo").first()).toBeVisible();
		await expect(page.locator("main ul li", { hasText: title })).toHaveCount(0);
	});

	test("a toggled checkbox holds its optimistic state until the refetch lands — no bounce", async ({
		page,
	}) => {
		// Review F2 regression guard. The old toggle voided its invalidations, so
		// the mutation flipped to success — and the pending reflection dropped —
		// while the cache still held the STALE completed value: the checkbox
		// visibly bounced back for the refetch RTT and was re-enabled while stale.
		// Returning the invalidation promises keeps the mutation pending until the
		// refetched truth is in the cache, so the reflection outlives the refetch.
		//
		// Gating: hold the list refetch open. After the UpdateTodo response is
		// OBSERVED — the exact moment the old bug bounced — the checkbox must still
		// show the optimistic state, disabled, with the row marked pending.
		const todo = await createBackendTodo(`E2E_OPT_NOBOUNCE_${String(Date.now())}`);
		try {
			let releaseList = (): void => {};
			const listGate = new Promise<void>((resolve) => {
				releaseList = resolve;
			});
			await page.route("**/todo.v1.TodoService/ListTodos**", async (route) => {
				await listGate;
				await route.continue();
			});

			await page.goto("/todos");
			await waitForHydration(page);

			const row = page.locator("main ul li", { hasText: todo.title });
			const checkbox = row.locator('input[type="checkbox"]');
			await expect(checkbox).not.toBeChecked();

			const updateResponse = page.waitForResponse((resp) =>
				resp.url().includes("/todo.v1.TodoService/UpdateTodo"),
			);
			await row.locator('[data-part="control"]').click();

			// Optimistic reflection: checked immediately.
			await expect(checkbox).toBeChecked();

			// Server confirmed — the old bug reverted to stale HERE for the RTT.
			const resp = await updateResponse;
			await resp.finished();
			await page.waitForTimeout(SETTLE_SLACK_MS);

			// No bounce: still checked, still pending (refetch gated), and disabled —
			// a second click cannot mutate from stale state.
			await expect(checkbox).toBeChecked();
			await expect(row).toHaveAttribute("data-pending", "true");
			await expect(checkbox).toBeDisabled();

			// Release the refetch: server truth lands (checked), pending clears, the
			// checkbox re-enables only now.
			releaseList();
			await expect(page.locator("main ul li[data-pending]", { hasText: todo.title })).toHaveCount(
				0,
			);
			await expect(checkbox).toBeChecked();
			await expect(checkbox).toBeEnabled();

			const after = await getBackendTodo(todo.id);
			expect(after.completed).toBe(true);
		} finally {
			await deleteBackendTodo(todo.id);
		}
	});

	test("a failed delete rolls back the optimistic removal (cache-snapshot restore)", async ({
		page,
	}) => {
		const todo = await createBackendTodo(`E2E_OPT_DELETE_ROLLBACK_${String(Date.now())}`);
		try {
			// Fail DeleteTodo so onError runs. Hang every CLIENT ListTodos so the ONLY
			// thing that can bring the row back is the onError snapshot restore — never
			// a settle refetch (which would mask a broken rollback). The initial list
			// is SSR-rendered + hydrated from the dehydrated cache, so no client
			// ListTodos fires on load; the first (and only) one is the delete's settle
			// invalidation, which we deliberately block.
			await page.route("**/todo.v1.TodoService/ListTodos**", () => new Promise<void>(() => {}));
			await page.route("**/todo.v1.TodoService/DeleteTodo", (route) => route.abort());

			await page.goto("/todos");
			await waitForHydration(page);

			const row = page.locator("main ul li", { hasText: todo.title });
			await expect(row).toBeVisible();

			await row.getByRole("button", { name: "Delete" }).click();
			await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();

			// Rolls back: the snapshot restore brings the row back, and the failure is
			// surfaced. (With the restore removed this row would stay gone — the teeth.)
			await expect(page.getByText("Failed to delete todo").first()).toBeVisible();
			await expect(row).toBeVisible();
		} finally {
			await deleteBackendTodo(todo.id);
		}
	});

	test("a failed details save rolls back the optimistic edit (cache-snapshot restore)", async ({
		page,
	}) => {
		// Review F4: the details editor's onError snapshot restore, isolated the
		// same way as the delete rollback above — hang the GetTodo settle refetch
		// so ONLY the restore can bring the original text back, and abort the
		// UpdateTodo write so onError runs.
		const initial = `Original details ${String(Date.now())}`;
		const replacement = "Optimistically replaced details";
		const todo = await createBackendTodo(`E2E_OPT_EDIT_ROLLBACK_${String(Date.now())}`, initial);
		try {
			// Reads use binary GET (query-string URLs), hence the trailing `**`. The
			// initial detail page is SSR-rendered + hydrated from the dehydrated
			// cache, so the only client GetTodo is the edit's settle refetch — hung.
			await page.route("**/todo.v1.TodoService/GetTodo**", () => new Promise<void>(() => {}));
			await page.route("**/todo.v1.TodoService/UpdateTodo", (route) => route.abort());

			await page.goto(`/todos/${todo.id}`);
			await waitForDetailHydration(page);
			await expect(page.getByText(initial)).toBeVisible();

			await page.getByRole("button", { name: "Edit details" }).click();
			const textarea = page.getByRole("textbox", { name: "Details" });
			await expect(textarea).toHaveValue(initial);
			await textarea.fill(replacement);
			await page.getByRole("button", { name: "Save", exact: true }).click();

			// Rollback: the failure surfaces and the read-view paragraph shows the
			// ORIGINAL text again — the onMutate write put `replacement` there, so
			// only the onError restore can revert it (the refetch is hung). The
			// textarea still holds `replacement`, but getByText matches rendered
			// text nodes, not input values, so the paragraph assertion is exact.
			await expect(page.getByText("Failed to save details").first()).toBeVisible();
			await expect(page.getByText(initial)).toBeVisible();
			await expect(page.getByText(replacement)).toHaveCount(0);
		} finally {
			await deleteBackendTodo(todo.id);
		}
	});

	test("cancelQueries guards the optimistic delete against a stale in-flight refetch", async ({
		page,
	}) => {
		// Refetch-race teeth, isolated to onMutate's cancelQueries and fully
		// GATE-DETERMINISTIC (review F5 — no fixed pre-delays racing CI speed):
		//
		//  1. Toggling a control todo starts list refetch #1, which we HOLD at the
		//     route layer — it stays in flight for as long as we choose.
		//  2. The victim is deleted. query-core awaits onMutate (cancelQueries)
		//     BEFORE calling the mutationFn, so OBSERVING the DeleteTodo request
		//     proves cancelQueries already ran while #1 was provably in flight —
		//     the exact race, pinned by ordering rather than timing.
		//  3. Observing DeleteTodo releases #1, whose response is served by the
		//     REAL server and still carries the victim: the DeleteTodo request is
		//     itself held until #1's response has been fetched AND delivered
		//     (route.fulfill), so the server processes the delete strictly after
		//     serving the stale list. NOTE: the list queryFn does not thread
		//     AbortSignal into the transport, so cancelQueries cancels at the
		//     query-core level (the result is discarded), not the network level —
		//     the stale response is DELIVERED in both cases; only a broken guard
		//     APPLIES it to the cache.
		//  4. Every later ListTodos (the delete's settle refetch) hangs, so nothing
		//     can correct a wrongly resurrected row. Guard intact: the victim stays
		//     gone. Guard removed: the stale response re-adds it and the final
		//     assertion fails (teeth-proven).
		const victim = await createBackendTodo(`E2E_OPT_CANCEL_VICTIM_${String(Date.now())}`);
		const control = await createBackendTodo(`E2E_OPT_CANCEL_CONTROL_${String(Date.now())}`);
		try {
			let releaseStale: () => void = () => {};
			const staleGate = new Promise<void>((resolve) => {
				releaseStale = resolve;
			});
			let staleDelivered: () => void = () => {};
			const staleDone = new Promise<void>((resolve) => {
				staleDelivered = resolve;
			});

			let listCalls = 0;
			await page.route("**/todo.v1.TodoService/ListTodos**", async (route) => {
				listCalls += 1;
				if (listCalls === 1) {
					// Refetch #1: held until the DeleteTodo request is observed, then
					// served from the real backend (which still holds the victim — the
					// delete is gated on staleDone below) and delivered to the renderer.
					//
					// route.fetch runs in the RUNNER (the host), which cannot resolve the
					// in-container browser's host.docker.internal origin — so the URL is
					// rewritten to the runner-reachable backend address, preserving the
					// Connect GET query string (and the request headers, incl. Origin, so
					// the backend answers with the same CORS headers as the live flow).
					await staleGate;
					try {
						const staleUrl = new URL(route.request().url());
						const backend = new URL(BACKEND_URL);
						staleUrl.protocol = backend.protocol;
						staleUrl.host = backend.host;
						const response = await route.fetch({ url: staleUrl.toString() });
						await route.fulfill({ response });
					} finally {
						staleDelivered();
					}
					return;
				}
				// The delete's settle refetch (and any later list fetch) hangs.
				return new Promise<void>(() => {});
			});

			await page.route("**/todo.v1.TodoService/DeleteTodo", async (route) => {
				// Observing DeleteTodo ⇒ onMutate (cancelQueries) has already run.
				releaseStale();
				// The server must serve the stale list before it processes the delete.
				await staleDone;
				await route.continue();
			});

			await page.goto("/todos");
			await waitForHydration(page);

			const victimRow = page.locator("main ul li", { hasText: victim.title });
			const controlRow = page.locator("main ul li", { hasText: control.title });
			await expect(victimRow).toBeVisible();
			await expect(controlRow).toBeVisible();

			// Toggle the control todo → its onSuccess invalidates the list, starting
			// refetch #1. Wait until it is actually in flight (held at the gate).
			const listRequest = page.waitForRequest("**/todo.v1.TodoService/ListTodos**");
			await controlRow.locator('[data-part="control"]').click();
			await listRequest;

			// Delete the victim while #1 is in flight → onMutate's cancelQueries must
			// cancel it (query-core level) before the DeleteTodo request goes out.
			await victimRow.getByRole("button", { name: "Delete" }).click();
			await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();

			// Ordered, gate-observed sequence: stale response delivered → delete
			// completed (success toast). Then bounded in-renderer slack: if the guard
			// were broken, the delivered stale data would have been applied within
			// these microtasks — long before the toast, in fact.
			await staleDone;
			await expect(page.getByText("Todo deleted").first()).toBeVisible();
			await page.waitForTimeout(SETTLE_SLACK_MS);
			await expect(victimRow).toHaveCount(0);
		} finally {
			// The victim is deleted by the test; ignore if already gone. Control remains.
			await listBackendTodos().then((todos) => {
				const v = todos.find((t) => t.title === victim.title);
				return v ? deleteBackendTodo(v.id) : undefined;
			});
			await deleteBackendTodo(control.id);
		}
	});

	test("toggling a todo with details preserves the details (F5)", async ({ page }) => {
		const details = `Important notes ${String(Date.now())}\nsecond line`;
		const todo = await createBackendTodo(`E2E_TOGGLE_DETAILS_${String(Date.now())}`, details);
		try {
			await page.goto("/todos");
			await waitForHydration(page);

			const row = page.locator("main ul li", { hasText: todo.title });
			const checkbox = row.locator('input[type="checkbox"]');
			await expect(checkbox).not.toBeChecked();

			// Toggle completed via the styled control.
			await row.locator('[data-part="control"]').click();
			await expect(checkbox).toBeChecked();

			// Wait for the toggle to SETTLE (pending clears only after the refetch
			// lands, which implies the server committed) so the backend read below
			// cannot race the in-flight UpdateTodo.
			await expect(page.locator("main ul li[data-pending]", { hasText: todo.title })).toHaveCount(
				0,
			);

			// The toggle sends ONLY { id, completed }, so the stored details must be
			// untouched: the backend confirms both the new completed flag AND the
			// verbatim details survive (the F5 invariant).
			const after = await getBackendTodo(todo.id);
			expect(after.completed).toBe(true);
			expect(after.details).toBe(details);

			// And the detail route still renders the details after the toggle.
			await page.goto(`/todos/${todo.id}`);
			await expect(page.getByText("Important notes").first()).toBeVisible();
			await expect(page.getByText("second line").first()).toBeVisible();
		} finally {
			await deleteBackendTodo(todo.id);
		}
	});
});
