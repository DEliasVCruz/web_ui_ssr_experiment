import { AsyncLocalStorage } from "node:async_hooks";
import type { WideEvent } from "./wide-event";

/**
 * The per-request observability context carried across the async call tree via
 * {@link AsyncLocalStorage} (stable on Bun 1.2+). Holds the mutable
 * {@link WideEvent} that the middleware finalizes and emits, plus the
 * `childTraceparent` to forward on any downstream RPC so the SSR event and the
 * backend event share one `trace_id`.
 */
export interface RequestContext {
	readonly event: WideEvent;
	readonly childTraceparent: string;
}

/**
 * The active request's observability context. Set by the wide-event middleware
 * at the fetch boundary (`requestContext.run(...)`) and read by the transport
 * interceptor to forward the trace context. Outside a request the store is
 * `undefined` (e.g. process warmup), and callers add no trace header.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The active request's observability context, or `undefined` outside a request. */
export function currentRequestContext(): RequestContext | undefined {
	return requestContext.getStore();
}
