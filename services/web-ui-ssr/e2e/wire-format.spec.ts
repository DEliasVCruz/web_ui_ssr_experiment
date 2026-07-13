import { expect } from "@playwright/test";
import { ADD_INPUT_SELECTOR, test, waitForHydration } from "./fixtures";

// The browser Connect transport is configured with `useBinaryFormat: true`
// (src/transport-client.ts), so every TodoService RPC must go over the wire as
// binary protobuf — Content-Type: application/proto — not Connect JSON.
// This spec locks that in: if someone reverts useBinaryFormat, it fails.
const PROTO_CONTENT_TYPE = "application/proto";

test.describe("RPC wire format", () => {
	test("browser TodoService RPCs use binary protobuf content-type", async ({ page }) => {
		const rpcRequests: {
			url: string;
			requestContentType?: string;
			responseContentType?: string;
		}[] = [];
		page.on("requestfinished", (req) => {
			if (!req.url().includes("/todo.v1.TodoService/")) return;
			void req.response().then((res) => {
				rpcRequests.push({
					url: req.url(),
					requestContentType: req.headers()["content-type"],
					responseContentType: res?.headers()["content-type"],
				});
			});
		});

		await page.goto("/todos");
		await waitForHydration(page);

		// Drive a real mutation + invalidation refetch so both write (CreateTodo)
		// and read (ListTodos) RPCs cross the wire, then clean up the todo.
		const input = page.locator(ADD_INPUT_SELECTOR);
		const uniqueTitle = `E2E_WIRE_${String(Date.now())}`;
		await input.fill(uniqueTitle);
		await page.getByRole("button", { name: "Add", exact: true }).click();
		const newRow = page.locator("main ul li", { hasText: uniqueTitle });
		await expect(newRow).toBeVisible();

		await newRow.getByRole("button", { name: "Delete" }).click();
		const confirmDialog = page.getByRole("dialog");
		await expect(confirmDialog).toBeVisible();
		await confirmDialog.getByRole("button", { name: "Delete" }).click();
		await expect(page.locator("main ul li", { hasText: uniqueTitle })).toHaveCount(0);

		// The flow above must have produced RPC traffic (CreateTodo, DeleteTodo,
		// plus ListTodos refetches) — an empty capture would make the assertions
		// below pass vacuously.
		await expect.poll(() => rpcRequests.length).toBeGreaterThanOrEqual(2);

		for (const rpc of rpcRequests) {
			expect(rpc.requestContentType, `request content-type for ${rpc.url}`).toBe(
				PROTO_CONTENT_TYPE,
			);
			expect(rpc.responseContentType, `response content-type for ${rpc.url}`).toBe(
				PROTO_CONTENT_TYPE,
			);
		}
	});
});
