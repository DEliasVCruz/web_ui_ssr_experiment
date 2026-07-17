import { afterEach, describe, expect, test } from "bun:test";
import {
	type BrowserWideEvent,
	createTraceParentInterceptor,
	currentAction,
	runAction,
	setActionEventSink,
} from "./browser-events";
import { parseTraceParent } from "./trace-context";

// The interceptor only ever touches `req.header` (a Headers) and forwards `req`
// to `next`, so a minimal request with a real Headers is a faithful stand-in for
// the connect-es UnaryRequest. `next` records the traceparent it received and can
// be made to throw, to exercise the failure tally.
type MockNext = (req: { header: Headers }) => Promise<{ ok: true }>;

function invokeInterceptor(next: MockNext) {
	// The Interceptor signature is typed against connect's Any(Unary|Stream)
	// request/response; cast through unknown so the test can drive it with the
	// minimal shape the interceptor actually reads.
	const interceptor = createTraceParentInterceptor();
	return interceptor(next as never) as unknown as MockNext;
}

/** A `next` that captures the outbound traceparent header of each call. */
function capturingNext(sink: string[]): MockNext {
	return (req) => {
		sink.push(req.header.get("traceparent") ?? "");
		return Promise.resolve({ ok: true });
	};
}

// Capture emitted wide events instead of writing them to the console.
let events: BrowserWideEvent[] = [];
setActionEventSink((event) => events.push(event));

afterEach(() => {
	events = [];
	setActionEventSink((event) => events.push(event));
});

describe("runAction wide event", () => {
	test("emits one event with the browser schema shape", async () => {
		await runAction("create_todo", async () => "done");

		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("no event");
		expect(event.component).toBe("web-ui-browser");
		expect(event.action).toBe("create_todo");
		expect(event.rpc_count).toBe(0);
		expect(event.rpc_failures).toBe(0);
		expect(event.error).toBeNull();
		expect(event.trace_id).toMatch(/^[0-9a-f]{32}$/);
		expect(event.span_id).toMatch(/^[0-9a-f]{16}$/);
		expect(typeof event.duration_ms).toBe("number");
		expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("projects a thrown error and still emits, then re-throws", async () => {
		let thrown: unknown;
		try {
			await runAction("delete_todo", () => Promise.reject(new Error("boom")));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("boom");

		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("no event");
		expect(event.action).toBe("delete_todo");
		expect(event.error).toEqual({ type: "Error", message: "boom" });
	});

	test("no action is active outside runAction", () => {
		expect(currentAction()).toBeUndefined();
	});
});

describe("traceparent interceptor", () => {
	test("reuses one trace_id across an action but mints a fresh span per RPC", async () => {
		const headers: string[] = [];
		const next = invokeInterceptor(capturingNext(headers));

		await runAction("toggle_todo", async () => {
			await next({ header: new Headers() });
			await next({ header: new Headers() });
		});

		expect(headers).toHaveLength(2);
		const first = parseTraceParent(headers[0]);
		const second = parseTraceParent(headers[1]);
		if (first === null || second === null) {
			throw new Error(`interceptor produced malformed traceparents: ${headers.join(", ")}`);
		}
		// Same trace across the action; distinct span per RPC.
		expect(first.traceId).toBe(second.traceId);
		expect(first.parentId).not.toBe(second.parentId);
		expect(first.flags).toBe("01");

		// The action's own event shares the trace and tallies both RPCs.
		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("no event");
		expect(event.trace_id).toBe(first.traceId);
		expect(event.rpc_count).toBe(2);
		expect(event.rpc_failures).toBe(0);
	});

	test("tallies an RPC failure on the action", async () => {
		const failingNext: MockNext = () => Promise.reject(new Error("rpc failed"));
		const next = invokeInterceptor(failingNext);

		let thrown: unknown;
		try {
			await runAction("create_todo", async () => {
				await next({ header: new Headers() });
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);

		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("no event");
		expect(event.rpc_count).toBe(1);
		expect(event.rpc_failures).toBe(1);
	});

	test("adds no traceparent header outside any action", async () => {
		const headers: string[] = [];
		const next = invokeInterceptor(capturingNext(headers));

		await next({ header: new Headers() });

		expect(headers).toEqual([""]);
		expect(events).toHaveLength(0);
	});
});
