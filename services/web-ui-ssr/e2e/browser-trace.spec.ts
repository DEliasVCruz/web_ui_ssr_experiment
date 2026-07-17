import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import {
	ADD_INPUT_SELECTOR,
	deleteBackendTodo,
	listBackendTodos,
	test,
	waitForHydration,
} from "./fixtures";

// TRUE browser→backend trace correlation (task iq2.4). A browser MUTATION issues
// its RPC straight to the Java backend (bypassing the SSR middleware), so the
// client transport's traceparent interceptor is that call's ONLY trace source.
// This spec proves the whole path: the action's trace_id appears in (1) the
// browser wide event on the console, (2) the outbound RPC's traceparent header
// (read via route interception), and (3) the backend's wide-event log line for
// that RPC — all three carry ONE trace_id, and the backend records the browser's
// RPC span as its parent.
//
// Harness guard mirrors wide-events.spec.ts: skip only OUTSIDE the ci:e2e harness
// (E2E_BACKEND_URL is its fingerprint); inside it, a missing backend log path is
// a hard failure, never a silent skip.
const { E2E_BACKEND_LOG, E2E_BACKEND_URL } = process.env;
const logsAvailable = E2E_BACKEND_LOG !== undefined;
const insideHarness = E2E_BACKEND_URL !== undefined;

const CREATE_RPC = "todo.v1.TodoService/CreateTodo";
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

interface BackendWideEvent {
	trace_id: string;
	span_id: string;
	parent_span_id: string | null;
	rpc_method: string | null;
	component: string;
}

interface BrowserWideEvent {
	trace_id: string;
	span_id: string;
	component: string;
	action: string;
	rpc_count: number;
	rpc_failures: number;
}

/** version-00 traceparent: `00-<32hex trace>-<16hex parent>-<2hex flags>`. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

async function findBackendEvent(
	logPath: string,
	predicate: (event: BackendWideEvent) => boolean,
): Promise<BackendWideEvent> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		let contents = "";
		try {
			contents = readFileSync(logPath, "utf-8");
		} catch {
			contents = "";
		}
		for (const line of contents.split("\n")) {
			if (!line.startsWith("{")) continue;
			let event: BackendWideEvent;
			try {
				event = JSON.parse(line) as BackendWideEvent;
			} catch {
				continue;
			}
			if (typeof event.trace_id === "string" && predicate(event)) {
				return event;
			}
		}
		// biome-ignore lint/performance/noAwaitInLoops: sequential polling of a log file is intentional here
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(`no backend wide-event line in ${logPath} matched after polling`);
}

test.describe("browser trace correlation", () => {
	test.skip(!logsAvailable && !insideHarness, "requires the ci:e2e harness (E2E_BACKEND_LOG)");

	test("a browser create RPC correlates browser action → header → backend on one trace_id", async ({
		page,
	}) => {
		if (E2E_BACKEND_LOG === undefined) {
			throw new Error(
				"ci:e2e harness detected (E2E_BACKEND_URL is set) but E2E_BACKEND_LOG is missing — " +
					"the wide-event log-capture exports in devenv.nix have regressed. Failing loudly.",
			);
		}

		// (2) Capture the outbound RPC's traceparent header via route interception.
		let rpcTraceparent: string | undefined;
		await page.route(`**/${CREATE_RPC}`, async (route) => {
			if (route.request().method() === "POST") {
				// Destructure (not dot access) — noPropertyAccessFromIndexSignature bars
				// `.traceparent` on the header index signature.
				const { traceparent } = route.request().headers();
				rpcTraceparent ??= traceparent;
			}
			await route.continue();
		});

		// (1) Capture the browser wide event emitted on the console for this action.
		const browserEvents: BrowserWideEvent[] = [];
		page.on("console", (msg) => {
			const text = msg.text();
			if (!text.startsWith("{")) return;
			try {
				const parsed = JSON.parse(text) as BrowserWideEvent;
				if (parsed.component === "web-ui-browser") browserEvents.push(parsed);
			} catch {
				// Not one of our JSON wide-event lines; ignore.
			}
		});

		await page.goto("/todos");
		await waitForHydration(page);

		const uniqueTitle = `E2E_TRACE_${String(Date.now())}`;
		await page.locator(ADD_INPUT_SELECTOR).fill(uniqueTitle);
		const addButton = page.getByRole("button", { name: "Add", exact: true });
		await expect(addButton).toBeEnabled();
		await addButton.click();

		// The optimistic row appears once the create RPC has been issued.
		await expect(page.locator("main ul li", { hasText: uniqueTitle })).toBeVisible();

		// The interceptor stamped a well-formed traceparent on the outbound RPC.
		expect(rpcTraceparent, "create RPC carried a traceparent header").toBeDefined();
		const match = TRACEPARENT.exec(rpcTraceparent ?? "");
		if (match === null) {
			throw new Error(`malformed traceparent on create RPC: ${String(rpcTraceparent)}`);
		}
		const headerTraceId = match[1];
		const headerSpanId = match[2];

		// (1) The browser wide event for the create action shares that trace_id.
		await expect
			.poll(() => browserEvents.some((e) => e.action === "create_todo"), {
				timeout: POLL_TIMEOUT_MS,
			})
			.toBe(true);
		const createEvent = browserEvents.find((e) => e.action === "create_todo");
		if (createEvent === undefined) throw new Error("no create_todo browser wide event captured");
		expect(createEvent.rpc_count).toBe(1);
		expect(createEvent.rpc_failures).toBe(0);
		expect(createEvent.trace_id).toBe(headerTraceId);

		// (3) The backend wide event for the same RPC carries the SAME trace_id and
		// records the browser's RPC span as its parent — full cross-service
		// correlation. TEETH: drop the header in the interceptor and the backend
		// mints its own trace_id, so this lookup times out.
		const backendEvent = await findBackendEvent(
			E2E_BACKEND_LOG,
			(event) => event.trace_id === headerTraceId && event.rpc_method === CREATE_RPC,
		);
		expect(backendEvent.component).toBe("business-logic-java");
		expect(backendEvent.parent_span_id).toBe(headerSpanId);

		// Self-clean the fixture against the real backend.
		const created = (await listBackendTodos()).find((t) => t.title === uniqueTitle);
		if (created !== undefined) await deleteBackendTodo(created.id);
	});
});
