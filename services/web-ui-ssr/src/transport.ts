import type { Interceptor } from "@connectrpc/connect";
import { addStaticKeyToTransport } from "@connectrpc/connect-query-core";
import { createConnectTransport } from "@connectrpc/connect-web";
import { currentRequestContext } from "./observability/request-context";

// Destructure with a default rather than `process.env.BUSINESS_LOGIC_URL`:
// noPropertyAccessFromIndexSignature (TS4111) forbids dot access on the env index
// signature, while biome's useLiteralKeys forbids `process.env["…"]`. Destructuring
// with a default is exempt from both and preserves the `?? default` semantics
// (env values are never null, so undefined-only defaulting is equivalent).
const { BUSINESS_LOGIC_URL = "http://localhost:3001" } = process.env;

/**
 * SSR transport — the same fetch-based connect-web transport the browser uses,
 * pointed at the business-logic server. Bun (and Node's global fetch) provide
 * the `fetch` connect-web needs, so there is no reason to keep the heavier
 * `@connectrpc/connect-node` transport just for SSR: one transport implementation
 * now serves both environments.
 *
 * `useHttpGet: true` lets idempotent (idempotency_level = NO_SIDE_EFFECTS) RPCs —
 * ListTodos and GetTodo — go over HTTP GET; mutations stay POST. `useBinaryFormat`
 * keeps every call on binary protobuf.
 */
const TRACEPARENT_HEADER = "traceparent";

/**
 * Propagates W3C trace context to the backend on every outbound RPC: the child
 * `traceparent` (this request's trace-id + this SSR span as the parent) is read
 * from the per-request AsyncLocalStorage seeded by the wide-event middleware, so
 * the SSR wide event and the Java wide event correlate on a shared `trace_id`.
 *
 * The context is also captured synchronously at transport-construction time —
 * `createServerTransport()` is called inside the request's ALS scope during
 * rendering — so forwarding still works even if a loader's RPC executes in a
 * detached async continuation (e.g. a stream-pull callback) where the store
 * would otherwise be unavailable. Outside a request (no store) no header is set.
 */
export function createServerTransport() {
	const captured = currentRequestContext();
	const traceContextInterceptor: Interceptor = (next) => (req) => {
		const context = currentRequestContext() ?? captured;
		if (context !== undefined) {
			req.header.set(TRACEPARENT_HEADER, context.childTraceparent);
		}
		return next(req);
	};

	return addStaticKeyToTransport(
		createConnectTransport({
			baseUrl: BUSINESS_LOGIC_URL,
			useBinaryFormat: true,
			useHttpGet: true,
			interceptors: [traceContextInterceptor],
		}),
		"app",
	);
}
