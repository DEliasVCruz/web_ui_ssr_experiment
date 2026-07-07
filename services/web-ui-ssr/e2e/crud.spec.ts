import { expect } from "@playwright/test";
import { ADD_INPUT_SELECTOR, test, waitForHydration } from "./fixtures";

// Exercises the full client -> backend write path plus TanStack Query cache
// invalidation. Uses a unique title and deletes it at the end so the suite is
// self-cleaning against the real backend.
test.describe("CRUD round-trip", () => {
	test("add, toggle, and delete a todo", async ({ page }) => {
		await page.goto("/todos");
		await waitForHydration(page);

		const input = page.locator(ADD_INPUT_SELECTOR);
		const addButton = page.getByRole("button", { name: "Add", exact: true });
		const uniqueTitle = `E2E_CRUD_${String(Date.now())}`;

		// ── ADD ──────────────────────────────────────────────────────────
		await input.fill(uniqueTitle);
		await expect(addButton).toBeEnabled();
		await addButton.click();

		const newRow = page.locator("main ul li", { hasText: uniqueTitle });
		await expect(newRow).toBeVisible();
		// Input clears on success (proves the mutation onSuccess ran client-side).
		await expect(input).toHaveValue("");

		// ── TOGGLE ───────────────────────────────────────────────────────
		// The completed control is now an Ark Checkbox: the real state lives on the
		// visually-hidden native <input type="checkbox">, and clicks land on the
		// styled control part. Assert on the input, interact via the control.
		const checkbox = newRow.locator('input[type="checkbox"]');
		await expect(checkbox).not.toBeChecked();
		await newRow.locator('[data-part="control"]').click();
		// After the update mutation + list invalidation refetch, it stays checked.
		await expect(checkbox).toBeChecked();

		// ── DELETE ───────────────────────────────────────────────────────
		// Delete is now a confirm dialog: the row button opens it, and the
		// destructive action runs only after confirming inside the dialog.
		await newRow.getByRole("button", { name: "Delete" }).click();
		const confirmDialog = page.getByRole("dialog");
		await expect(confirmDialog).toBeVisible();
		await confirmDialog.getByRole("button", { name: "Delete" }).click();
		await expect(page.locator("main ul li", { hasText: uniqueTitle })).toHaveCount(0);
	});
});
