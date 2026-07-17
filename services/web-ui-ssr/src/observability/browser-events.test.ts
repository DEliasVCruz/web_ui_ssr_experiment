import { afterEach, describe, expect, test } from "bun:test";
import {
	type BrowserWideEvent,
	beginAction,
	type CapturedActionContext,
	captureActionContext,
	createTraceParentInterceptor,
	currentAction,
	endAction,
	runAction,
	runActionWithContext,
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

// Offline queue (task 1w9.4 §4.4): the action's trace + offline flag are CAPTURED
// at enqueue and carried in the mutation variables; the RPC is REPLAYED under that
// captured context — never re-derived from `activeAction` at flush time (which is
// `undefined` during a background flush). This is the unit teeth for teeth (b):
// swap runActionWithContext to read activeAction and the trace correlation below
// breaks (no traceparent header; the wrong/absent trace_id on the event).
describe("captured-context replay", () => {
	test("captureActionContext mints a fresh trace and records the enqueue-time offline flag", () => {
		const captured = captureActionContext("create_todo");
		expect(captured.action).toBe("create_todo");
		expect(captured.traceId).toMatch(/^[0-9a-f]{32}$/);
		// The flag reflects navigator.onLine at capture — a boolean either way (the
		// bun runtime has no meaningful onLine, so we assert the shape, not the value;
		// the true/false split is proven by the replay + runAction tests).
		expect(typeof captured.offlineQueued).toBe("boolean");
	});

	test("runAction flags offline_queued=false (a live action)", async () => {
		await runAction("navigate", async () => "x");
		expect(events).toHaveLength(1);
		expect(events[0]?.offline_queued).toBe(false);
	});

	test("replays the RPC under the ENQUEUE-time trace and flags offline_queued=true", async () => {
		// A token as it would be persisted for a create enqueued while OFFLINE.
		const enqueued: CapturedActionContext = {
			traceId: "abcdef0123456789abcdef0123456789",
			action: "create_todo",
			offlineQueued: true,
		};
		const headers: string[] = [];
		const next = invokeInterceptor(capturingNext(headers));

		// No action is active at flush time — the ONLY trace source is the captured
		// token. (Read activeAction instead and the interceptor would add no header.)
		expect(currentAction()).toBeUndefined();
		await runActionWithContext(enqueued, async () => {
			await next({ header: new Headers() });
		});

		// The replayed RPC's traceparent carries the enqueue-time trace_id verbatim.
		expect(headers).toHaveLength(1);
		const parsed = parseTraceParent(headers[0]);
		if (parsed === null) throw new Error(`malformed traceparent: ${String(headers[0])}`);
		expect(parsed.traceId).toBe(enqueued.traceId);

		// Exactly ONE wide event, correlated on that trace and flagged as queued.
		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("no replay event");
		expect(event.trace_id).toBe(enqueued.traceId);
		expect(event.action).toBe("create_todo");
		expect(event.offline_queued).toBe(true);
		expect(event.rpc_count).toBe(1);
		// The scope is closed after replay — nothing leaks as active.
		expect(currentAction()).toBeUndefined();
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
