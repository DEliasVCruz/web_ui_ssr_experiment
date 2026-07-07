import { expect } from "@playwright/test";
import { test, waitForHydration } from "./fixtures";

// Guards the Add-form accessibility (ol9.2 Field adoption): the input must have
// a real accessible name — not just a placeholder. A visually-hidden Field.Label
// supplies it via aria-labelledby, so the input is reachable by role + name.
test.describe("accessibility", () => {
	test("the add-todo input has an accessible name via its Field.Label", async ({ page }) => {
		await page.goto("/todos");
		await waitForHydration(page);

		// Resolves through the accessibility tree: only passes if the input's
		// accessible name is "New todo" (from aria-labelledby → the hidden label),
		// which a placeholder alone does NOT provide.
		const namedInput = page.getByRole("textbox", { name: "New todo" });
		await expect(namedInput).toBeVisible();

		// And it is the same field used to add todos (placeholder unchanged).
		await expect(namedInput).toHaveAttribute("placeholder", "What needs to be done?");
	});
});
