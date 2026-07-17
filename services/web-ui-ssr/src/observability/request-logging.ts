import { type RequestContext, requestContext } from "./request-context";
import { formatTraceParent, resolveTraceContext } from "./trace-context";
import { toWideEventError, type WideEvent } from "./wide-event";
import type { WideEventLogger } from "./wide-event-logger";

// The emitting service's name, stamped on every event's `component` field.
const COMPONENT = "web-ui-ssr";
const INTERNAL_ERROR_STATUS = 500;

type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * Wraps a fetch handler so it emits exactly one wide event per request. The
 * event is finalized and emitted when the response body FINISHES streaming (not
 * when the handler returns), so `duration_ms` covers the whole render — SSR
 * responses stream, and the bytes are passed through unchanged (an identity
 * `TransformStream`), so raw-HTML assertions are unaffected.
 *
 * The handler runs inside `requestContext.run(...)`, so downstream RPCs issued
 * during rendering can read the trace context (via the transport interceptor)
 * and forward it, giving the SSR and backend events a shared `trace_id`.
 */
export function createWideEventMiddleware(
	logger: WideEventLogger,
): (handler: FetchHandler) => (request: Request) => Promise<Response> {
	return (handler) => (request) => handleRequest(request, logger, () => handler(request));
}

function handleRequest(
	request: Request,
	logger: WideEventLogger,
	next: () => Response | Promise<Response>,
): Promise<Response> {
	const start = performance.now();
	const trace = resolveTraceContext(request.headers.get("traceparent"));
	const event: WideEvent = {
		trace_id: trace.traceId,
		span_id: trace.spanId,
		parent_span_id: trace.parentSpanId,
		timestamp: "",
		duration_ms: 0,
		http_method: request.method,
		path: new URL(request.url).pathname,
		status: 0,
		connect_code: null,
		rpc_method: null,
		component: COMPONENT,
		error: null,
		attributes: {},
	};
	const context: RequestContext = {
		event,
		childTraceparent: formatTraceParent(trace.traceId, trace.spanId, trace.flags),
	};

	let emitted = false;
	const finalizeAndEmit = (): void => {
		if (emitted) {
			return;
		}
		emitted = true;
		event.duration_ms = Math.round(performance.now() - start);
		event.timestamp = new Date().toISOString();
		logger.emit(event);
	};

	return requestContext.run(context, async () => {
		let response: Response;
		try {
			response = await next();
		} catch (error) {
			event.error = toWideEventError(error);
			event.status = INTERNAL_ERROR_STATUS;
			finalizeAndEmit();
			throw error;
		}

		event.status = response.status;
		if (response.body === null) {
			finalizeAndEmit();
			return response;
		}

		// Emit when the streamed body completes. `flush` fires after the source
		// stream closes (SSR render done); an identity transform leaves bytes
		// untouched. A client that disconnects mid-stream aborts the transform
		// without a flush — those rare truncated requests emit no event, an
		// accepted trade for never altering the response.
		const monitored = response.body.pipeThrough(
			new TransformStream({
				flush() {
					finalizeAndEmit();
				},
			}),
		);
		return new Response(monitored, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	});
}
