import { expect, type Page } from "@playwright/test";
import { MAX_DETAILS_LENGTH } from "../src/validation/todo";
import {
	createBackendTodo,
	deleteBackendTodo,
	fetchSsrHtml,
	getBackendTodo,
	test,
} from "./fixtures";

// The todo details view/edit flow (a4a.2). These specs prove: details render
// SERVER-SIDE on the detail route; the focused editor persists an edit through
// the real UpdateTodo write path; the empty-string CLEAR path works end to end
// (the app-level clear mechanism — this is what pins field-guide #2's explicit
// presence); and the proto-derived max-length gates the write client-side.

// One past the proto's details max_len, derived from the generated-schema bound
// (currently 1000) so the fixture — like the loose message assertion below —
// stays meaningful under any proto constraint change.
const OVER_MAX_DETAILS = "d".repeat(MAX_DETAILS_LENGTH + 1);
// Give a wrongly-fired RPC time to appear on the wire before asserting none did.
const SETTLE_MS = 500;

/**
 * Detail-page hydration probe. The list-page `waitForHydration` keys off the Add
 * input, which does not exist here; instead we wait until Solid has attached its
 * delegated click handler (`$$click`) to the "Edit details" button — the
 * authoritative "this page is interactive" signal for the detail route.
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

test.describe("todo details view/edit", () => {
	test("details render server-side on the detail route", async () => {
		const detailsText = `SSR details ${String(Date.now())}\nsecond line`;
		const todo = await createBackendTodo(`E2E_DETAILS_SSR_${String(Date.now())}`, detailsText);
		try {
			const html = await fetchSsrHtml(`/todos/${todo.id}`);

			// The Details section label and the actual notes text are in the RAW
			// server response — not merely the dehydrated data blob or client render.
			expect(html).toContain(">Details</h2>");
			expect(html).toContain("SSR details");
			expect(html).toContain("second line");
			// A todo WITH details must not render the empty-state copy.
			expect(html).not.toContain("No details yet.");
		} finally {
			await deleteBackendTodo(todo.id);
		}
	});

	test("edit details persists through the write path", async ({ page }) => {
		const todo = await createBackendTodo(`E2E_DETAILS_EDIT_${String(Date.now())}`);
		const newDetails = "First line of notes\nSecond line of notes";
		try {
			await page.goto(`/todos/${todo.id}`);
			await waitForDetailHydration(page);

			// Starts with no details.
			await expect(page.getByText("No details yet.")).toBeVisible();

			await page.getByRole("button", { name: "Edit details" }).click();
			const textarea = page.getByRole("textbox", { name: "Details" });
			await expect(textarea).toBeVisible();
			// Seeded from the current (never-set) details: the {...todo} spread drops
			// the unset field, so the runtime value is undefined — the editor must
			// normalize it to "" (F1).
			await expect(textarea).toHaveValue("");

			// Saving the untouched empty editor on a NEVER-SET todo must be a clean
			// save (details:""), never a spurious over-length error under an empty
			// textarea (the validateDetails(undefined) regression).
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await expect(page.getByText(/Details must be at most/i)).toHaveCount(0);
			// The save succeeded: the editor closed and the empty state remains.
			await expect(page.getByRole("textbox", { name: "Details" })).toHaveCount(0);
			await expect(page.getByText("No details yet.")).toBeVisible();

			// Reopen and do the real edit.
			await page.getByRole("button", { name: "Edit details" }).click();
			await expect(textarea).toBeVisible();
			await textarea.fill(newDetails);
			await page.getByRole("button", { name: "Save", exact: true }).click();

			// Read view returns and shows the persisted details; the editor closes.
			await expect(page.getByText("First line of notes")).toBeVisible();
			await expect(page.getByRole("textbox", { name: "Details" })).toHaveCount(0);

			// Server is the source of truth: reload (fresh SSR + loader fetch) and the
			// details survive — proving persistence, not just cache state.
			await page.reload();
			await waitForDetailHydration(page);
			await expect(page.getByText("First line of notes")).toBeVisible();

			// And confirm the exact value round-tripped through the backend.
			const persisted = await getBackendTodo(todo.id);
			expect(persisted.details).toBe(newDetails);
		} finally {
			await deleteBackendTodo(todo.id);
		}
	});

	test("clearing details sends the empty string and clears stored content", async ({ page }) => {
		const initial = "Details that will be cleared";
		const todo = await createBackendTodo(`E2E_DETAILS_CLEAR_${String(Date.now())}`, initial);
		try {
			await page.goto(`/todos/${todo.id}`);
			await waitForDetailHydration(page);

			// Starts WITH details.
			await expect(page.getByText(initial)).toBeVisible();

			await page.getByRole("button", { name: "Edit details" }).click();
			const textarea = page.getByRole("textbox", { name: "Details" });
			await expect(textarea).toHaveValue(initial);

			// Clear to the empty string — the deliberate clear value (field-guide #2).
			await textarea.fill("");
			await page.getByRole("button", { name: "Save", exact: true }).click();

			// Read view shows the empty state; the old text is gone.
			await expect(page.getByText("No details yet.")).toBeVisible();
			await expect(page.getByText(initial)).toHaveCount(0);

			// Reload from the server: the clear persisted (this is what has teeth —
			// omitting details on clear would leave the original text and fail here).
			await page.reload();
			await waitForDetailHydration(page);
			await expect(page.getByText("No details yet.")).toBeVisible();
			await expect(page.getByText(initial)).toHaveCount(0);

			// Backend confirms the content was cleared (stored "" verbatim, or NULL —
			// either way, no longer the original text).
			const persisted = await getBackendTodo(todo.id);
			expect(persisted.details ?? "").toBe("");
		} finally {
			await deleteBackendTodo(todo.id);
		}
	});

	test("over-length details show an error and issue no UpdateTodo RPC", async ({ page }) => {
		const todo = await createBackendTodo(`E2E_DETAILS_VALIDATION_${String(Date.now())}`);
		const updateCalls: string[] = [];
		page.on("request", (req) => {
			if (req.method() === "POST" && req.url().includes("/todo.v1.TodoService/UpdateTodo")) {
				updateCalls.push(req.url());
			}
		});
		try {
			await page.goto(`/todos/${todo.id}`);
			await waitForDetailHydration(page);

			await page.getByRole("button", { name: "Edit details" }).click();
			const textarea = page.getByRole("textbox", { name: "Details" });
			await textarea.fill(OVER_MAX_DETAILS);

			// onChange validation surfaces a human-readable, proto-derived message.
			await expect(page.getByText(/Details must be at most/i)).toBeVisible();

			// The onSubmit guard must stop the mutation: clicking Save fires NO
			// UpdateTodo request.
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await page.waitForTimeout(SETTLE_MS);
			expect(updateCalls).toEqual([]);
		} finally {
			await deleteBackendTodo(todo.id);
		}
	});
});
