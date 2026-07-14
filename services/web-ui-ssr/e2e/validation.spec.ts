import { expect } from "@playwright/test";
import { ADD_INPUT_SELECTOR, test, waitForHydration } from "./fixtures";

// The create-form title validator is derived from the proto's buf.validate
// constraints (min_len 1 / max_len 100) via JSON Schema → arktype. These specs
// prove that the client-side validation actually gates the write path: an
// over-length title surfaces an error AND is prevented from ever issuing a
// CreateTodo RPC, and an empty title keeps Add disabled (pre-existing behavior).

// One past the proto's max_len (100); the exact number is asserted loosely below
// so the spec survives a constraint change.
const OVER_MAX_LENGTH = 101;
const OVER_MAX_TITLE = "a".repeat(OVER_MAX_LENGTH);
// Give a wrongly-fired RPC time to appear on the wire before asserting none did.
const SETTLE_MS = 500;

test.describe("create-form validation (proto-derived)", () => {
	test("an over-length title shows an error and issues no CreateTodo RPC", async ({ page }) => {
		const createCalls: string[] = [];
		page.on("request", (req) => {
			if (req.method() === "POST" && req.url().includes("/todo.v1.TodoService/CreateTodo")) {
				createCalls.push(req.url());
			}
		});

		await page.goto("/todos");
		await waitForHydration(page);

		const input = page.locator(ADD_INPUT_SELECTOR);
		const addButton = page.getByRole("button", { name: "Add", exact: true });

		await input.fill(OVER_MAX_TITLE);

		// onChange validation surfaces a human-readable, proto-derived message.
		await expect(page.getByText(/Title must be at most/i)).toBeVisible();

		// The button is enabled (the title is non-empty), but the onSubmit guard
		// must stop the mutation: clicking Add fires NO CreateTodo request.
		await addButton.click();
		await page.waitForTimeout(SETTLE_MS);
		expect(createCalls).toEqual([]);

		// The input keeps its value (a successful create would have cleared it).
		await expect(input).toHaveValue(OVER_MAX_TITLE);
	});

	test("an empty title keeps the Add button disabled", async ({ page }) => {
		await page.goto("/todos");
		await waitForHydration(page);

		const input = page.locator(ADD_INPUT_SELECTOR);
		const addButton = page.getByRole("button", { name: "Add", exact: true });

		// Empty on load → disabled; typing enables; clearing disables again.
		await expect(addButton).toBeDisabled();
		await input.fill("A real todo");
		await expect(addButton).toBeEnabled();
		await input.fill("");
		await expect(addButton).toBeDisabled();
	});
});
