import { expect } from "@playwright/test";
import { ADD_INPUT_SELECTOR, test } from "./fixtures";

// THE regression guard. The nd3 blocking bug (client never hydrates → page inert)
// passed typecheck/biome/eslint/build/curl and was only caught by driving a real
// browser. These assertions MUST genuinely fail if hydration breaks.
test.describe("hydration + interactivity (regression guard)", () => {
	test("delegated handlers attach, typing enables Add, and the event buffer drains", async ({
		page,
	}) => {
		await page.goto("/todos");

		const input = page.locator(ADD_INPUT_SELECTOR);
		await expect(input).toBeVisible();

		const addButton = page.getByRole("button", { name: "Add", exact: true });
		// Server-rendered state: the button is disabled because the title is empty.
		await expect(addButton).toBeDisabled();

		// Signal 1 (authoritative): Solid attaches a delegated `onInput` handler
		// (`$$input` is a function) to the Add input once hydration runs. If the
		// client never hydrates this never becomes a function and the poll fails.
		await expect
			.poll(() =>
				input.evaluate(
					(el) => typeof (el as Element & { $$input?: unknown }).$$input === "function",
				),
			)
			.toBe(true);

		// Signal 2 (completion): Solid's pre-hydration event buffer drains to 0.
		// Polled (not a hard read) so it can't false-fail if read a tick early.
		await expect
			.poll(() =>
				page.evaluate(() => {
					// biome-ignore lint/style/useNamingConvention: `_$HY` is Solid's hydration global; the name is fixed by the framework
					const hy = (window as unknown as { _$HY?: { events?: unknown[] } })._$HY;
					return hy?.events?.length ?? -1;
				}),
			)
			.toBe(0);

		// Signal 3 (authoritative): typing into the Add input flips the previously
		// disabled button to enabled — proves reactivity + event handlers are live,
		// not just that static HTML rendered.
		await input.fill("hydration-probe");
		await expect(addButton).toBeEnabled();

		// And clearing it disables the button again.
		await input.fill("");
		await expect(addButton).toBeDisabled();
	});
});
