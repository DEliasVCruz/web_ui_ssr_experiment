import { expect } from "@playwright/test";
import { ADD_INPUT_SELECTOR, test, waitForHydration } from "./fixtures";

// Toast notifications are NET-NEW UX (ol9.5): mutation success/error now surface
// as Ark Toasts (replacing the old inline <p> error blocks). One test proves the
// success path (add), one forces the RPC to fail and proves the error path.
test.describe("toast notifications", () => {
	test("a success toast appears after adding a todo", async ({ page }) => {
		await page.goto("/todos");
		await waitForHydration(page);

		const input = page.locator(ADD_INPUT_SELECTOR);
		const addButton = page.getByRole("button", { name: "Add", exact: true });
		const uniqueTitle = `E2E_TOAST_${String(Date.now())}`;

		await input.fill(uniqueTitle);
		await addButton.click();

		// Success toast surfaces.
		await expect(page.getByText("Todo added").first()).toBeVisible();

		// Self-clean: remove the row we created (via the confirm dialog).
		const row = page.locator("main ul li", { hasText: uniqueTitle });
		await expect(row).toBeVisible();
		await row.getByRole("button", { name: "Delete" }).click();
		await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
		await expect(page.locator("main ul li", { hasText: uniqueTitle })).toHaveCount(0);
	});

	test("an error toast appears when the create RPC fails", async ({ page }) => {
		await page.goto("/todos");
		await waitForHydration(page);

		// Force the CreateTodo RPC to fail so the mutation's onError path runs.
		await page.route("**/todo.v1.TodoService/CreateTodo", (route) => route.abort());

		const input = page.locator(ADD_INPUT_SELECTOR);
		await input.fill("E2E_TOAST_ERROR");
		await page.getByRole("button", { name: "Add", exact: true }).click();

		// Error toast surfaces, and the input is NOT cleared (onSuccess never ran).
		await expect(page.getByText("Failed to add todo").first()).toBeVisible();
		await expect(input).toHaveValue("E2E_TOAST_ERROR");

		await page.unroute("**/todo.v1.TodoService/CreateTodo");
	});
});
