import { type RequestContext, requestContext } from "./request-context";
import { formatTraceParent, resolveTraceContext } from "./trace-context";
import { toWideEventError, type WideEvent } from "./wide-event";
import type { WideEventLogger } from "./wide-event-logger";

// The emitting service's name, stamped on every event's `component` field.
const COMPONENT = "web-ui-ssr";
const INTERNAL_ERROR_STATUS = 500;

// `attributes.stream_outcome` records how the response body's stream TERMINATED,
// for the three streamed terminal outcomes (a null-body or thrown-handler
// response never opens a stream, so the key is absent there):
//   * "completed" — the source stream closed normally: the full SSR render
//     flushed. `error` is null; `status` is the status that was sent.
//   * "errored"   — the source stream ERRORED mid-body, after the shell (and
//     thus the status + headers) had already flushed. The event records the
//     projected `error` AND the ALREADY-SENT `status` (an errored stream cannot
//     retroactively change a status the client has received — unlike a handler
//     that throws before any bytes leave, which we can still synthesize as 500).
//   * "cancelled" — the DOWNSTREAM consumer cancelled the body (client
//     disconnected mid-stream). Not a server fault, so `error` stays null; the
//     truncation is marked solely by this outcome. `status` is the sent status.
const STREAM_OUTCOME = "stream_outcome";
const STREAM_COMPLETED = "completed";
const STREAM_ERRORED = "errored";
const STREAM_CANCELLED = "cancelled";

type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * Wraps a fetch handler so it emits exactly one wide event per request. The
 * event is finalized and emitted when the response body FINISHES streaming (not
 * when the handler returns), so `duration_ms` covers the whole render — SSR
 * responses stream, and the bytes are passed through unchanged (a manual
 * reader pump, below), so raw-HTML assertions are unaffected.
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

		// Emit when the streamed body reaches a TERMINAL outcome. A MANUAL READER
		// PUMP (not an identity `TransformStream`) is used deliberately: the
		// transform's `flush` fires only on the NORMAL close, and Bun (pinned
		// 1.3.10; behaviour re-verified on 1.3.11) does NOT invoke a transformer's
		// `cancel()` hook when the source stream errors or the reader is cancelled.
		// A TransformStream therefore left two silent paths — a source that errors
		// after the shell flush, and a client that disconnects mid-stream — which
		// is exactly the mid-render failure observability most needs. The pump
		// below closes both by emitting on all three terminal outcomes (close /
		// error / cancel; see `stream_outcome`).
		//
		// Pass-through purity + backpressure: `pull` is demand-driven — the stream
		// machinery calls it only while the consumer has capacity (desiredSize > 0)
		// — and it reads exactly ONE source chunk per call and enqueues it
		// unchanged, so bytes are never mutated and nothing buffers ahead of
		// demand. Exactly-once is guarded by `emitted` (shared with the null-body
		// and thrown paths): terminal outcomes can race (a cancel landing while a
		// `read()` is in flight), and the guard collapses any second finalize into
		// a no-op — it also gates post-terminal controller calls, which would
		// otherwise throw on an already-settled controller.
		const reader = response.body.getReader();
		const finalizeStream = (outcome: string, error?: unknown): void => {
			event.attributes[STREAM_OUTCOME] = outcome;
			if (error !== undefined) {
				event.error = toWideEventError(error);
			}
			finalizeAndEmit();
		};
		const monitored = new ReadableStream<Uint8Array>({
			async pull(controller) {
				let result: Awaited<ReturnType<typeof reader.read>>;
				try {
					result = await reader.read();
				} catch (error) {
					// The SOURCE stream errored mid-body. Status + headers already
					// flushed, so we surface the error downstream and record it.
					if (emitted) {
						return;
					}
					controller.error(error);
					finalizeStream(STREAM_ERRORED, error);
					return;
				}
				// A cancel may have finalized the stream while `read()` was in flight;
				// touching the controller now would throw, so bail on the guard.
				if (emitted) {
					return;
				}
				if (result.done) {
					controller.close();
					finalizeStream(STREAM_COMPLETED);
					return;
				}
				controller.enqueue(result.value);
			},
			cancel(reason) {
				// The DOWNSTREAM consumer cancelled (client disconnect): mark the
				// truncation and propagate the cancel upstream to release the source.
				finalizeStream(STREAM_CANCELLED);
				return reader.cancel(reason);
			},
		});
		return new Response(monitored, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	});
}
