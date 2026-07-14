import { expect } from "@playwright/test";
import { ADD_INPUT_SELECTOR, test, waitForHydration } from "./fixtures";

// The browser Connect transport is configured with `useBinaryFormat: true` and
// `useHttpGet: true` (src/transport-client.ts), so every TodoService RPC must
// cross the wire as binary protobuf, and idempotent RPCs (idempotency_level =
// NO_SIDE_EFFECTS: ListTodos, GetTodo) must travel over HTTP GET while mutations
// stay POST. This spec locks all of that in: revert useBinaryFormat or
// useHttpGet (or the proto idempotency options) and it fails.
const PROTO_CONTENT_TYPE = "application/proto";

// RPCs that carry idempotency_level = NO_SIDE_EFFECTS and therefore must use GET.
const READ_RPCS = new Set(["ListTodos", "GetTodo"]);
// Mutations — no idempotency option — which must stay POST.
const WRITE_RPCS = new Set(["CreateTodo", "UpdateTodo", "DeleteTodo"]);

interface CapturedRpc {
	rpc: string;
	method: string;
	url: string;
	requestContentType?: string;
	responseContentType?: string;
}

test.describe("RPC wire format", () => {
	test("reads use binary GET, mutations use binary POST", async ({ page }) => {
		const rpcRequests: CapturedRpc[] = [];
		page.on("requestfinished", (req) => {
			if (!req.url().includes("/todo.v1.TodoService/")) return;
			const rpc = new URL(req.url()).pathname.split("/").pop() ?? "";
			void req.response().then((res) => {
				rpcRequests.push({
					rpc,
					method: req.method(),
					url: req.url(),
					requestContentType: req.headers()["content-type"],
					responseContentType: res?.headers()["content-type"],
				});
			});
		});

		await page.goto("/todos");
		await waitForHydration(page);

		// Create a todo (CreateTodo POST + ListTodos GET refetch)...
		const input = page.locator(ADD_INPUT_SELECTOR);
		const uniqueTitle = `E2E_WIRE_${String(Date.now())}`;
		await input.fill(uniqueTitle);
		await page.getByRole("button", { name: "Add", exact: true }).click();
		const newRow = page.locator("main ul li", { hasText: uniqueTitle });
		await expect(newRow).toBeVisible();

		// ...navigate into its detail page (GetTodo GET) via the title link...
		await newRow.getByRole("link", { name: uniqueTitle }).click();
		await expect(page.getByRole("heading", { name: uniqueTitle })).toBeVisible();
		await page.goBack();
		await expect(page.locator("main ul li", { hasText: uniqueTitle })).toBeVisible();

		// ...then delete it (DeleteTodo POST + ListTodos GET refetch).
		const row = page.locator("main ul li", { hasText: uniqueTitle });
		await row.getByRole("button", { name: "Delete" }).click();
		const confirmDialog = page.getByRole("dialog");
		await expect(confirmDialog).toBeVisible();
		await confirmDialog.getByRole("button", { name: "Delete" }).click();
		await expect(page.locator("main ul li", { hasText: uniqueTitle })).toHaveCount(0);

		// The flow must have produced both a GET read and a POST write; empty or
		// one-sided captures would make the per-request assertions vacuous.
		await expect
			.poll(() => rpcRequests.filter((r) => r.method === "GET" && READ_RPCS.has(r.rpc)).length)
			.toBeGreaterThanOrEqual(1);
		await expect
			.poll(() => rpcRequests.filter((r) => r.method === "POST" && WRITE_RPCS.has(r.rpc)).length)
			.toBeGreaterThanOrEqual(1);

		for (const rpc of rpcRequests) {
			if (READ_RPCS.has(rpc.rpc)) {
				// Idempotent reads: binary GET carrying the Connect query params.
				expect(rpc.method, `method for ${rpc.rpc}`).toBe("GET");
				expect(rpc.url, `GET url for ${rpc.rpc}`).toContain("connect=v1");
				expect(rpc.url, `GET url for ${rpc.rpc}`).toContain("encoding=proto");
				expect(rpc.url, `GET url for ${rpc.rpc}`).toContain("base64=1");
			} else if (WRITE_RPCS.has(rpc.rpc)) {
				// Mutations: binary POST with a protobuf request body.
				expect(rpc.method, `method for ${rpc.rpc}`).toBe("POST");
				expect(rpc.requestContentType, `request content-type for ${rpc.rpc}`).toBe(
					PROTO_CONTENT_TYPE,
				);
			} else {
				throw new Error(`unexpected RPC captured: ${rpc.rpc} (${rpc.url})`);
			}
			// Every response — read or write — is binary protobuf.
			expect(rpc.responseContentType, `response content-type for ${rpc.rpc}`).toBe(
				PROTO_CONTENT_TYPE,
			);
		}
	});
});
