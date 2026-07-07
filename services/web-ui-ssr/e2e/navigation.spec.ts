import { expect } from "@playwright/test";
import { test, waitForHydration } from "./fixtures";

test.describe("client-side navigation", () => {
	test("clicking a todo updates URL + title with no full reload; back works", async ({ page }) => {
		await page.goto("/todos");
		await waitForHydration(page);

		// Plant a sentinel on window. A full document reload wipes globals; if the
		// nav is a genuine client-side transition the sentinel survives.
		await page.evaluate(() => {
			(window as unknown as { __spaSentinel?: string }).__spaSentinel = "alive";
		});

		// Track document (navigation) requests fired after the sentinel is planted.
		const documentRequests: string[] = [];
		page.on("request", (req) => {
			if (req.resourceType() === "document") {
				documentRequests.push(req.url());
			}
		});

		const firstTodo = page.locator('main ul li a[href^="/todos/"]').first();
		const href = await firstTodo.getAttribute("href");
		expect(href).toBeTruthy();
		const todoTitle = ((await firstTodo.textContent()) ?? "").trim();
		expect(todoTitle.length).toBeGreaterThan(0);

		await firstTodo.click();

		// URL + dynamic <title> updated to the detail route.
		await expect(page).toHaveURL(new RegExp(`${href ?? ""}$`));
		await expect(page).toHaveTitle(`${todoTitle} | Web UI SSR`);

		// Proof of client-side nav: sentinel persisted and no document navigation.
		const sentinel = await page.evaluate(
			() => (window as unknown as { __spaSentinel?: string }).__spaSentinel,
		);
		expect(sentinel).toBe("alive");
		expect(documentRequests).toEqual([]);

		// Back navigation returns to the list.
		await page.goBack();
		await expect(page).toHaveURL(/\/todos$/);
		await expect(page).toHaveTitle("Todos | Web UI SSR");
	});
});
