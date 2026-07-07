import { expect } from "@playwright/test";
import { ADD_INPUT_SELECTOR, test, waitForHydration } from "./fixtures";

// The delete confirmation is NET-NEW UX (ol9.4): an Ark Dialog. These tests
// prove it opens, that Cancel/ESC dismiss it WITHOUT deleting, and that only
// Confirm performs the delete. Self-cleaning: seeds its own row and removes it.
test.describe("delete confirmation dialog", () => {
	test("opens on Delete; Cancel and ESC keep the todo; Confirm deletes it", async ({ page }) => {
		await page.goto("/todos");
		await waitForHydration(page);

		const input = page.locator(ADD_INPUT_SELECTOR);
		const addButton = page.getByRole("button", { name: "Add", exact: true });
		const uniqueTitle = `E2E_DIALOG_${String(Date.now())}`;

		// Seed a row to operate on.
		await input.fill(uniqueTitle);
		await addButton.click();
		const row = page.locator("main ul li", { hasText: uniqueTitle });
		await expect(row).toBeVisible();

		// ── OPEN ─────────────────────────────────────────────────────────
		await row.getByRole("button", { name: "Delete" }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText("Delete todo?");
		// The dialog names the specific todo being deleted.
		await expect(dialog).toContainText(uniqueTitle);

		// ── CANCEL keeps the todo ──────────────────────────────────────────
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toBeHidden();
		await expect(row).toBeVisible();

		// ── ESC also dismisses with no effect (focus trap + keyboard a11y) ──
		await row.getByRole("button", { name: "Delete" }).click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toBeHidden();
		await expect(row).toBeVisible();

		// ── CONFIRM deletes ────────────────────────────────────────────────
		await row.getByRole("button", { name: "Delete" }).click();
		const confirmDialog = page.getByRole("dialog");
		await expect(confirmDialog).toBeVisible();
		await confirmDialog.getByRole("button", { name: "Delete" }).click();
		await expect(page.locator("main ul li", { hasText: uniqueTitle })).toHaveCount(0);
	});
});
