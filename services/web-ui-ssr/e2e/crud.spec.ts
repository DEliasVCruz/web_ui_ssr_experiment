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
		const checkbox = newRow.locator('input[type="checkbox"]');
		await expect(checkbox).not.toBeChecked();
		await checkbox.click();
		// After the update mutation + list invalidation refetch, it stays checked.
		await expect(checkbox).toBeChecked();

		// ── DELETE ───────────────────────────────────────────────────────
		await newRow.getByRole("button", { name: "Delete" }).click();
		await expect(page.locator("main ul li", { hasText: uniqueTitle })).toHaveCount(0);
	});
});
