import { expect } from "@playwright/test";
import { test, waitForHydration } from "./fixtures";

// The SSR loader pre-fills the query cache and dehydrates it into the document.
// On initial client load the app must read from that dehydrated state and fire
// ZERO TodoService RPCs — otherwise SSR data-passing is broken (double fetch).
test.describe("no double-fetch", () => {
	test("initial /todos load fires no TodoService RPC", async ({ page }) => {
		const rpcCalls: string[] = [];
		page.on("request", (req) => {
			if (req.url().includes("/todo.v1.TodoService/")) {
				rpcCalls.push(req.url());
			}
		});

		// networkidle lets any stray refetch settle before we assert.
		await page.goto("/todos", { waitUntil: "networkidle" });
		await waitForHydration(page);

		expect(rpcCalls).toEqual([]);
	});
});
