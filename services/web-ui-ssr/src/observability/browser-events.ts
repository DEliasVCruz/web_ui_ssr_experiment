import type { Interceptor } from "@connectrpc/connect";
import { ConsoleTransport, LogLayer } from "loglayer";
import { DEFAULT_TRACE_FLAGS, formatTraceParent, mintSpanId, mintTraceId } from "./trace-context";

// Browser-side wide events + W3C trace propagation (task iq2.4). The client's
// RPCs go browser→Java DIRECTLY, bypassing the SSR wide-event middleware, so
// this module is the ONLY trace source for them. It deliberately does NOT pull
// in the OpenTelemetry web SDK (25–60kB gz on the hydration-critical path);
// LogLayer's console transport keeps the whole path small (see the bundle-delta
// note in docs/wide-events.md).
//
// The unit of instrumentation is one USER ACTION (a mutation flow, or a route
// navigation) — NOT a page load and NOT a single RPC. An action:
//   * mints ONE `trace_id` (its whole span tree shares it),
//   * mints a fresh `span_id` per outbound RPC (the client span recorded as that
//     RPC's `traceparent` parent-id, so the backend's `parent_span_id` points
//     back at the browser), and
//   * emits ONE wide event when it finishes, mirroring the server schema fields
//     that make sense in a browser (see docs/wide-events.md → "Browser variant").
//
// SSR safety: this module is import-safe under SSR. It touches no browser-only
// global at import time — `crypto.getRandomValues`, `performance.now`, `console`
// and LogLayer all exist on Bun/Node too — and the logger is built lazily on
// first emit. In practice `runAction`/`beginAction` only ever fire client-side
// (mutations and post-hydration navigations), so no event is emitted during SSR.

const TRACEPARENT_HEADER = "traceparent";
const COMPONENT = "web-ui-browser";
// A stable marker on every browser wide-event console line, so log consumers (and
// the e2e console-capture assertion) can pick our events out of other console
// chatter without depending on field order.
const EVENT_MESSAGE = "web-ui-browser wide_event";

/** The `error` projection of a browser wide event (no stack — kept lean). */
export interface BrowserWideEventError {
	readonly type: string;
	readonly message: string;
}

/**
 * One browser wide event: emitted per USER ACTION. A client-side sibling of the
 * server {@link import("./wide-event").WideEvent}, carrying the subset of fields
 * that are meaningful in a browser plus the action-specific `action` /
 * `rpc_count` / `rpc_failures`. `component` is always `"web-ui-browser"`.
 */
export interface BrowserWideEvent {
	readonly trace_id: string;
	readonly span_id: string;
	readonly timestamp: string;
	readonly duration_ms: number;
	readonly component: typeof COMPONENT;
	readonly action: string;
	readonly rpc_count: number;
	readonly rpc_failures: number;
	readonly error: BrowserWideEventError | null;
}

/**
 * The mutable context of one in-flight action. `traceId`/`spanId`/`flags` are
 * fixed at creation (one trace per action, one root span); the RPC counters are
 * incremented by the transport interceptor as the action's calls fly, and
 * `error` is set if the action throws.
 */
interface ActionContext {
	readonly traceId: string;
	readonly spanId: string;
	readonly flags: string;
	readonly name: string;
	readonly startedAt: number;
	rpcCount: number;
	rpcFailures: number;
	error: BrowserWideEventError | null;
	/**
	 * Set by {@link endAction}. An ended context is dead: it is never restored as
	 * the active action (the restore walk skips it), and ending it again is a
	 * no-op — which makes `endAction` idempotent and FIFO-overlap safe.
	 */
	ended: boolean;
	/** The action that was active when this one began (the restore chain). */
	readonly previous: ActionContext | undefined;
}

// The single active action. JS is single-threaded, so the transport interceptor
// (which runs synchronously when a call is issued) reads exactly the action
// under which the call was made.
//
// Overlap safety (reviewed, F1): actions may complete in ANY order, not just
// LIFO. Each context records the `previous` action active when it began, and
// `endAction` (a) marks the context `ended`, (b) restores activation ONLY when
// the ending context is itself the active one, and (c) walks the `previous`
// chain past already-ended contexts. So in the FIFO case (A begins, B begins,
// A settles first) ending A leaves B active, and ending B restores `undefined`
// — a dead, already-emitted action can never become active again, and RPCs
// issued outside any action stay honestly unattributed (no traceparent).
//
// Remaining pragmatic boundary (documented in docs/wide-events.md): while two
// actions actually OVERLAP, an RPC is attributed to the most recently begun
// action still active at the instant it is issued. Attribution of any
// synchronously issued RPC is exact regardless.
let activeAction: ActionContext | undefined;

function createActionContext(name: string, previous: ActionContext | undefined): ActionContext {
	return {
		traceId: mintTraceId(),
		spanId: mintSpanId(),
		flags: DEFAULT_TRACE_FLAGS,
		name,
		startedAt: performance.now(),
		rpcCount: 0,
		rpcFailures: 0,
		error: null,
		ended: false,
		previous,
	};
}

function toBrowserError(thrown: unknown): BrowserWideEventError {
	if (thrown instanceof Error) {
		const type = thrown.name.length > 0 ? thrown.name : thrown.constructor.name;
		return { type, message: thrown.message.length > 0 ? thrown.message : type };
	}
	return { type: typeof thrown, message: String(thrown) };
}

const MS_ROUNDING = 1;
function buildActionEvent(ctx: ActionContext): BrowserWideEvent {
	return {
		trace_id: ctx.traceId,
		span_id: ctx.spanId,
		timestamp: new Date().toISOString(),
		duration_ms: Math.round((performance.now() - ctx.startedAt) / MS_ROUNDING),
		component: COMPONENT,
		action: ctx.name,
		rpc_count: ctx.rpcCount,
		rpc_failures: ctx.rpcFailures,
		error: ctx.error,
	};
}

// LogLayer over its built-in ConsoleTransport, configured so each event is
// emitted as ONE JSON string (messageField + stringify): the schema fields flat
// at the root plus the `message` marker, so a browser console line is both
// human-scannable and machine-parseable (`JSON.parse` of the single arg). Built
// lazily so importing this module has no side effects (SSR-safe).
let logger: LogLayer | undefined;
function getLogger(): LogLayer {
	logger ??= new LogLayer({
		transport: new ConsoleTransport({ logger: console, messageField: "message", stringify: true }),
	});
	return logger;
}

/** The wide-event sink. Swappable via {@link setActionEventSink} for tests. */
type ActionEventSink = (event: BrowserWideEvent) => void;
let sink: ActionEventSink | null = null;

function emit(ctx: ActionContext): void {
	const event = buildActionEvent(ctx);
	if (sink !== null) {
		sink(event);
		return;
	}
	getLogger()
		.withMetadata(event as unknown as Record<string, unknown>)
		.info(EVENT_MESSAGE);
}

/**
 * Test seam: redirect emitted browser wide events to `sink` (pass `null` to
 * restore the default console emission). Not used in production.
 */
export function setActionEventSink(next: ActionEventSink | null): void {
	sink = next;
}

/** The action currently in scope, read synchronously by the interceptor. */
export function currentAction(): ActionContext | undefined {
	return activeAction;
}

/** A begun action's restore token, closed out by {@link endAction}. */
export interface ActionHandle {
	readonly ctx: ActionContext;
}

/**
 * Opens a user-action scope that spans async work (e.g. a route navigation whose
 * loaders fire RPCs asynchronously). Every RPC issued while it is open shares its
 * `trace_id`. MUST be paired with {@link endAction}. Prefer {@link runAction}
 * where the action is a single async function.
 */
export function beginAction(name: string): ActionHandle {
	const ctx = createActionContext(name, activeAction);
	activeAction = ctx;
	return { ctx };
}

/**
 * Closes an action opened by {@link beginAction}, emitting its wide event.
 * Idempotent: a second close of the same handle is a no-op (no double emit), so
 * redundant close paths (e.g. a navigation closed by both supersede and the
 * resolve/render subscriptions) are safe.
 *
 * FIFO-overlap safe (review F1): activation is restored ONLY if this context is
 * the currently active one, and the restore walks the `previous` chain past
 * already-ended contexts — a dead action can never become active again.
 */
export function endAction(handle: ActionHandle, error?: unknown): void {
	const ctx = handle.ctx;
	if (ctx.ended) {
		return;
	}
	if (error !== undefined) {
		ctx.error = toBrowserError(error);
	}
	ctx.ended = true;
	if (activeAction === ctx) {
		let next = ctx.previous;
		while (next !== undefined && next.ended) {
			next = next.previous;
		}
		activeAction = next;
	}
	emit(ctx);
}

/**
 * Runs `fn` as one user action: mints its trace, makes it the active action for
 * the duration, and emits its wide event on completion (success or throw). The
 * natural wrapper for a mutation flow, whose RPC is issued synchronously at the
 * start of `fn` — see the mutation hooks in `src/queries/todos.ts`.
 */
export async function runAction<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const handle = beginAction(name);
	try {
		const result = await fn();
		endAction(handle);
		return result;
	} catch (error) {
		endAction(handle, error);
		throw error;
	}
}

/**
 * The client transport's trace interceptor — the ONLY trace source for
 * browser→Java RPCs. Built here (not in `transport-client.ts`) so it is unit
 * testable without the client bundle's build-time `PUBLIC_BUSINESS_LOGIC_URL`
 * define; wired into the sole `createConnectTransport` call in
 * `transport-client.ts` (the transport-centralization rule).
 *
 * For every call issued inside an action it stamps a child `traceparent` (the
 * action's `trace_id` + a FRESH span per RPC as the parent-id) and tallies the
 * call — and its failure — on the action. Outside any action (e.g. a background
 * query refetch not tied to a user action) it adds no header: the backend then
 * starts a fresh trace, exactly as for an un-propagated request.
 */
export function createTraceParentInterceptor(): Interceptor {
	return (next) => async (req) => {
		const action = activeAction;
		if (action === undefined) {
			return next(req);
		}
		// Synchronous prefix: header + count are set in the same tick the call is
		// issued, so `action` is unambiguously the issuing action.
		action.rpcCount += 1;
		req.header.set(
			TRACEPARENT_HEADER,
			formatTraceParent(action.traceId, mintSpanId(), action.flags),
		);
		try {
			return await next(req);
		} catch (error) {
			action.rpcFailures += 1;
			throw error;
		}
	};
}

// Exported for the unit tests (pure event construction) — production emits via
// `emit`.
export { buildActionEvent, EVENT_MESSAGE };
