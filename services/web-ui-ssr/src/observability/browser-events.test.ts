import { afterEach, describe, expect, test } from "bun:test";
import {
	type BrowserWideEvent,
	beginAction,
	createTraceParentInterceptor,
	currentAction,
	endAction,
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

// Review F1: overlapping actions may settle in ANY order, not just LIFO. A dead
// (already-emitted) action must never become active again — otherwise every
// later out-of-action RPC (e.g. the invalidation refetch after a mutation
// settles) would be stamped with the dead action's trace.
describe("non-LIFO (FIFO) overlap safety", () => {
	test("A begins, B begins, A settles first: B stays active, then nothing is", async () => {
		const headers: string[] = [];
		const next = invokeInterceptor(capturingNext(headers));

		const a = beginAction("navigate");
		const b = beginAction("create_todo");

		// FIFO: the earlier action settles first. B must remain the active action.
		endAction(a);
		expect(currentAction()).toBe(b.ctx);

		// An RPC issued now belongs to B, not to the dead A.
		await next({ header: new Headers() });
		const during = parseTraceParent(headers[0]);
		if (during === null) throw new Error(`malformed traceparent: ${String(headers[0])}`);
		expect(during.traceId).toBe(b.ctx.traceId);
		expect(during.traceId).not.toBe(a.ctx.traceId);

		// B settles: the restore walk skips the dead A — nothing is active.
		endAction(b);
		expect(currentAction()).toBeUndefined();

		// An out-of-action RPC (a background refetch) carries NO header.
		await next({ header: new Headers() });
		expect(headers[1]).toBe("");

		// Both actions emitted exactly once.
		const emittedActions = events.map((e) => e.action);
		emittedActions.sort((x, y) => x.localeCompare(y));
		expect(emittedActions).toEqual(["create_todo", "navigate"]);
	});

	test("mutation overlapping a navigation that settles first leaks nothing", async () => {
		const headers: string[] = [];
		const next = invokeInterceptor(capturingNext(headers));

		// A navigation scope opens; a mutation begins while it is unresolved.
		const nav = beginAction("navigate");
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const mutation = runAction("create_todo", async () => {
			await next({ header: new Headers() });
			await gate;
		});

		// The navigation resolves while the mutation is still in flight (FIFO).
		endAction(nav);

		// The mutation settles; its `previous` (the nav) is dead, so nothing
		// becomes active — the post-settle invalidation refetch is unattributed.
		if (release === undefined) throw new Error("gate not initialised");
		release();
		await mutation;
		expect(currentAction()).toBeUndefined();

		await next({ header: new Headers() });
		expect(headers[1]).toBe("");

		// The mutation's RPC was attributed to the mutation, not the navigation.
		const mutationHeader = parseTraceParent(headers[0]);
		if (mutationHeader === null) throw new Error(`malformed traceparent: ${String(headers[0])}`);
		const mutationEvent = events.find((e) => e.action === "create_todo");
		if (mutationEvent === undefined) throw new Error("no create_todo event");
		expect(mutationHeader.traceId).toBe(mutationEvent.trace_id);
	});

	test("endAction is idempotent: a double close emits once and restores nothing stale", () => {
		const nav = beginAction("navigate");
		endAction(nav);
		// Second close (e.g. supersede + onResolved/onRendered backstops in
		// entry-client) is a no-op: no second event, no reactivation.
		endAction(nav);
		expect(events).toHaveLength(1);
		expect(currentAction()).toBeUndefined();
	});
});
