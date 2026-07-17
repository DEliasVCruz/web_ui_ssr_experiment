import { expect } from "@playwright/test";
import { test, waitForHydration } from "./fixtures";

// View Transitions API adoption (a4a4). Chromium (the CDP browser here) supports
// `document.startViewTransition`, so we can assert the router actually drives it
// on a route change — and that reduced-motion users get NO transition at all.
//
// The spy wraps `Document.prototype.startViewTransition` via addInitScript, which
// runs before any page script on every load/navigation, so it is in place before
// the router's first navigation. It counts calls onto `window.__vtCalls`.
// The real DOM signature of Document.startViewTransition, reused for both the
// saved original and the patched wrapper.
type StartViewTransition = Document["startViewTransition"];

const SPY_INIT = () => {
	const w = window as unknown as { __vtCalls: number };
	w.__vtCalls = 0;
	// Cast the prototype so `startViewTransition` reads as a plain function-typed
	// PROPERTY (not a method), which keeps @typescript-eslint/unbound-method quiet
	// on the save below — while typing it to the REAL signature (not an
	// `unknown`-returning shim) so the wrapper stays assignable back to it with no
	// TS2322 and no ts-ignore.
	const proto = Document.prototype as Document & { startViewTransition?: StartViewTransition };
	const original = proto.startViewTransition;
	if (typeof original === "function") {
		proto.startViewTransition = function patched(
			this: Document,
			...args: Parameters<StartViewTransition>
		): ViewTransition {
			w.__vtCalls += 1;
			return original.apply(this, args);
		};
	}
};

function readVtCalls(page: import("@playwright/test").Page): Promise<number> {
	return page.evaluate(() => (window as unknown as { __vtCalls?: number }).__vtCalls ?? 0);
}

test.describe("View Transitions", () => {
	test("route navigation invokes startViewTransition (transitions enabled)", async ({ page }) => {
		await page.addInitScript(SPY_INIT);
		await page.goto("/todos");
		await waitForHydration(page);

		// Initial load/hydration is not a router view transition; the counter should
		// still be zero before we navigate.
		expect(await readVtCalls(page)).toBe(0);

		const firstTodo = page.locator('main ul li a[href^="/todos/"]').first();
		const href = await firstTodo.getAttribute("href");
		expect(href).toBeTruthy();

		await firstTodo.click();
		await expect(page).toHaveURL(new RegExp(`${href ?? ""}$`));

		// The router called document.startViewTransition for the route change.
		await expect.poll(() => readVtCalls(page)).toBeGreaterThan(0);
	});

	test("reduced motion: no view transition is invoked on navigation", async ({ page }) => {
		// Must be set before load so the router reads it (via matchMedia) at
		// hydration and leaves defaultViewTransition disabled.
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.addInitScript(SPY_INIT);
		await page.goto("/todos");
		await waitForHydration(page);

		const firstTodo = page.locator('main ul li a[href^="/todos/"]').first();
		const href = await firstTodo.getAttribute("href");
		expect(href).toBeTruthy();

		await firstTodo.click();
		await expect(page).toHaveURL(new RegExp(`${href ?? ""}$`));

		// Give any stray transition a chance to fire, then assert none did.
		await expect(page.locator("h1")).toBeVisible();
		expect(await readVtCalls(page)).toBe(0);
	});
});
