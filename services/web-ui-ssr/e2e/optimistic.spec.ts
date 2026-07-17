import { expect } from "@playwright/test";
import {
	ADD_INPUT_SELECTOR,
	createBackendTodo,
	deleteBackendTodo,
	getBackendTodo,
	listBackendTodos,
	test,
	waitForHydration,
} from "./fixtures";

// Optimistic updates (a4a.3). These specs prove the UI stays snappy under
// latency: an optimistic CREATE row renders before the server confirms; a failed
// create/delete rolls back visibly and surfaces the shared error toast; the
// cache-snapshot DELETE path both rolls back on error and guards the refetch race
// with cancelQueries; and toggling a todo WITH details never clobbers the details
// (F5). Interactions with the server are shaped with Playwright route
// interception on the RPCs (gate / abort / delay / hang).

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

		// The pending row is present — dimmed via data-pending — BEFORE the server
		// has answered (the RPC is still gated).
		const pendingRow = page.locator("main ul li[data-pending]", { hasText: title });
		await expect(pendingRow).toBeVisible();

		// Release the server; the optimistic row reconciles to a confirmed row
		// (data-pending drops once the settle invalidation lands the real row).
		release();
		await expect(page.locator("main ul li[data-pending]", { hasText: title })).toHaveCount(0);
		await expect(page.locator("main ul li", { hasText: title })).toBeVisible();

		// Self-clean: find the confirmed todo on the backend and remove it.
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

		// Rollback: the optimistic row disappears (the mutation-state pending row
		// only exists while the create is in flight) and the error is surfaced.
		await expect(page.getByText("Failed to add todo").first()).toBeVisible();
		await expect(page.locator("main ul li", { hasText: title })).toHaveCount(0);
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

	test("cancelQueries guards the optimistic delete against a stale in-flight refetch", async ({
		page,
	}) => {
		// Refetch-race teeth, isolated to onMutate's cancelQueries. Timeline:
		//  1. Toggling a control todo triggers a ListTodos refetch (#1) that we hold,
		//     then replay with a STALE snapshot still containing the victim.
		//  2. While #1 is in flight we delete the victim. DeleteTodo itself is DELAYED
		//     so the delete's own settle invalidation (#2) does NOT fire until well
		//     after #1 has resolved — otherwise #2 would supersede/cancel #1 and mask
		//     the guard (that masking is exactly why an earlier version passed even
		//     with cancelQueries removed).
		//  3. During that delete window only onMutate's cancelQueries can stop #1's
		//     stale response from resurrecting the victim. #2 is hung, so nothing
		//     corrects a wrong outcome. With the guard: victim stays gone. Without it:
		//     the stale #1 lands and the victim reappears (the teeth).
		// The stale refetch resolves at ~DELAY_MS; DeleteTodo is held DELETE_DELAY_MS
		// (> DELAY_MS) so the window straddles #1's resolution deterministically.
		const DELAY_MS = 1000;
		const DELETE_DELAY_MS = 2500;
		// Slack so a non-cancelled stale response AND the delayed DeleteTodo have both
		// resolved (leaving #2 hung) before we assert.
		const BUFFER_MS = 750;
		const victim = await createBackendTodo(`E2E_OPT_CANCEL_VICTIM_${String(Date.now())}`);
		const control = await createBackendTodo(`E2E_OPT_CANCEL_CONTROL_${String(Date.now())}`);
		try {
			let listCalls = 0;
			await page.route("**/todo.v1.TodoService/ListTodos**", async (route) => {
				listCalls += 1;
				if (listCalls === 1) {
					// The stale in-flight refetch: held, then let through to the REAL
					// server. Because DeleteTodo is delayed (below), the server still holds
					// the victim when this resolves, so it returns a genuine (binary-encoded)
					// response WITH the victim — the exact stale write cancelQueries must
					// prevent. Replaying a hand-built JSON body would not do: reads use
					// binary GET, so only a real server response actually lands in the cache.
					// If cancelQueries cancelled the fetch, this continue() throws on the
					// aborted request — swallow it (that IS the guard firing).
					await sleep(DELAY_MS);
					try {
						await route.continue();
					} catch {
						// Request was cancelled (the cancelQueries guard) — nothing to continue.
					}
					return;
				}
				// Every later ListTodos (the delete's settle invalidation) hangs, so the
				// server can never correct a wrongly-resurrected row — isolating the test
				// to the cancelQueries behaviour.
				return new Promise<void>(() => {});
			});

			// Delay DeleteTodo so its onSettled refetch (#2) is deferred past #1's
			// resolution — see the timeline note above.
			await page.route("**/todo.v1.TodoService/DeleteTodo", async (route) => {
				await sleep(DELETE_DELAY_MS);
				await route.continue();
			});

			await page.goto("/todos");
			await waitForHydration(page);

			const victimRow = page.locator("main ul li", { hasText: victim.title });
			const controlRow = page.locator("main ul li", { hasText: control.title });
			await expect(victimRow).toBeVisible();
			await expect(controlRow).toBeVisible();

			// Toggle the control todo → its onSuccess invalidates the list, starting
			// the stale ListTodos refetch (#1). Wait until it is actually in flight.
			const listRequest = page.waitForRequest("**/todo.v1.TodoService/ListTodos**");
			await controlRow.locator('[data-part="control"]').click();
			await listRequest;

			// Delete the victim while the stale refetch is in flight → onMutate's
			// cancelQueries must cancel it. (DeleteTodo is delayed, so #2 stays deferred.)
			await victimRow.getByRole("button", { name: "Delete" }).click();
			await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();

			// Wait past both #1's resolution and the delayed DeleteTodo (after which #2
			// is issued and hangs), then assert the victim stayed gone — true only if
			// onMutate's cancelQueries cancelled the stale #1.
			await page.waitForTimeout(DELETE_DELAY_MS + BUFFER_MS);
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
