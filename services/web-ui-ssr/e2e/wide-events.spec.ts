import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { RAW_BASE_URL, test } from "./fixtures";

// The SSR + backend servers write their wide-event JSON lines to stdout, which
// `devenv tasks run ci:e2e` redirects to these files. Reading them lets us prove
// the epic's deliverable end-to-end: a single trace_id flows from an inbound
// request through the SSR event and into the backend event. Destructured with a
// presence check (dot access is barred by noPropertyAccessFromIndexSignature and
// bracket access by biome useLiteralKeys); absent outside the ci:e2e harness.
const { E2E_SSR_LOG, E2E_BACKEND_LOG } = process.env;
const logsAvailable = E2E_SSR_LOG !== undefined && E2E_BACKEND_LOG !== undefined;

// A stable, spec-supplied caller span so we can assert the SSR event records it
// as parent_span_id (proves inbound adoption, not just minting).
const INBOUND_PARENT_ID = "00f067aa0ba902b7";
const TRACE_ID_BYTES = 16;
const HEX_RADIX = 16;
const HEX_PAD_WIDTH = 2;
const HTTP_OK = 200;
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

interface WideEvent {
	trace_id: string;
	span_id: string;
	parent_span_id: string | null;
	component: string;
	path: string;
	status: number;
	rpc_method: string | null;
	http_method: string;
}

function randomTraceId(): string {
	const bytes = new Uint8Array(TRACE_ID_BYTES);
	crypto.getRandomValues(bytes);
	let id = "";
	for (const byte of bytes) {
		id += byte.toString(HEX_RADIX).padStart(HEX_PAD_WIDTH, "0");
	}
	return id;
}

/** Polls a wide-event log file for a JSON line matching `predicate`. */
async function findEvent(
	logPath: string,
	predicate: (event: WideEvent) => boolean,
): Promise<WideEvent> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	let lastError = "no matching wide-event line";
	while (Date.now() < deadline) {
		let contents = "";
		try {
			contents = readFileSync(logPath, "utf-8");
		} catch {
			contents = "";
		}
		for (const line of contents.split("\n")) {
			if (!line.startsWith("{")) {
				continue;
			}
			let event: WideEvent;
			try {
				event = JSON.parse(line) as WideEvent;
			} catch {
				continue;
			}
			if (typeof event.trace_id === "string" && predicate(event)) {
				return event;
			}
		}
		lastError = `no wide-event line in ${logPath} matched after polling`;
		// biome-ignore lint/performance/noAwaitInLoops: sequential polling of a log file is intentional here
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(lastError);
}

test.describe("wide events", () => {
	test.skip(!logsAvailable, "requires the ci:e2e harness (E2E_SSR_LOG / E2E_BACKEND_LOG)");

	test("one SSR request produces a single wide event correlated with the backend", async () => {
		const traceId = randomTraceId();
		const traceparent = `00-${traceId}-${INBOUND_PARENT_ID}-01`;

		// Drive one SSR render of /todos (its loader calls ListTodos on the backend).
		const response = await fetch(`${RAW_BASE_URL}/todos`, { headers: { traceparent } });
		expect(response.status).toBe(HTTP_OK);
		await response.text();

		if (E2E_SSR_LOG === undefined || E2E_BACKEND_LOG === undefined) {
			throw new Error("unreachable: guarded by test.skip");
		}

		// The SSR event: inbound trace adopted, caller recorded as parent, fresh span.
		const ssrEvent = await findEvent(
			E2E_SSR_LOG,
			(event) => event.trace_id === traceId && event.path === "/todos",
		);
		expect(ssrEvent.component).toBe("web-ui-ssr");
		expect(ssrEvent.parent_span_id).toBe(INBOUND_PARENT_ID);
		expect(ssrEvent.status).toBe(HTTP_OK);
		expect(ssrEvent.http_method).toBe("GET");
		expect(ssrEvent.span_id).toMatch(/^[0-9a-f]{16}$/);

		// The backend event shares the trace_id and records the SSR span as its
		// parent — full cross-service correlation. TEETH: if the transport
		// interceptor stops forwarding the traceparent, the backend mints its own
		// trace_id and this lookup times out.
		const backendEvent = await findEvent(
			E2E_BACKEND_LOG,
			(event) => event.trace_id === traceId && event.rpc_method === "todo.v1.TodoService/ListTodos",
		);
		expect(backendEvent.component).toBe("business-logic-java");
		expect(backendEvent.parent_span_id).toBe(ssrEvent.span_id);
	});
});
