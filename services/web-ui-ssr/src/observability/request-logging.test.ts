import { describe, expect, test } from "bun:test";
import { createWideEventMiddleware } from "./request-logging";
import type { WideEvent } from "./wide-event";
import type { WideEventLogger } from "./wide-event-logger";

// Lifecycle invariants of the wide-event middleware: exactly ONE emission per
// request on every terminal outcome — streamed success (close), null body,
// thrown handler, a SOURCE stream that errors mid-body, and a DOWNSTREAM
// consumer that cancels mid-stream — with the streamed emission happening at the
// stream's terminal transition (not handler return) and response bytes passing
// through unchanged. The manual reader pump records how a streamed body ended in
// `attributes.stream_outcome` ("completed" | "errored" | "cancelled").

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_INTERNAL_ERROR = 500;
const SETTLE_MS = 25;
const STREAM_OUTCOME = "stream_outcome";

function capture(): { logger: WideEventLogger; events: WideEvent[] } {
	const events: WideEvent[] = [];
	return {
		logger: {
			emit(event: WideEvent): void {
				events.push(structuredClone(event));
			},
		},
		events,
	};
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

describe("createWideEventMiddleware lifecycle", () => {
	test("streamed response: exactly one emit, at stream completion, bytes unchanged", async () => {
		const { logger, events } = capture();
		const encoder = new TextEncoder();

		// Gate the source so nothing can flow (and thus nothing can flush) until
		// the test releases it — pinning "emit at completion, not handler return".
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await gate;
				controller.enqueue(encoder.encode("<html>"));
				controller.enqueue(encoder.encode("</html>"));
				controller.close();
			},
		});

		const handler = createWideEventMiddleware(logger)(
			() => new Response(body, { status: HTTP_OK, headers: { "content-type": "text/html" } }),
		);
		const response = await handler(
			new Request("http://localhost/todos", { headers: { traceparent: VALID_TRACEPARENT } }),
		);

		// Handler has returned, stream still open: nothing may be emitted yet.
		await settle();
		expect(events).toHaveLength(0);

		if (release === undefined) throw new Error("gate release not initialized");
		release();
		const text = await response.text();
		await settle();

		// Bytes untouched, exactly one event, finalized fields set.
		expect(text).toBe("<html></html>");
		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("expected one event");
		expect(event.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(event.parent_span_id).toBe("00f067aa0ba902b7");
		expect(event.http_method).toBe("GET");
		expect(event.path).toBe("/todos");
		expect(event.status).toBe(HTTP_OK);
		expect(event.component).toBe("web-ui-ssr");
		expect(event.error).toBeNull();
		expect(event.attributes[STREAM_OUTCOME]).toBe("completed");
		expect(event.timestamp).not.toBe("");
		expect(event.duration_ms).toBeGreaterThanOrEqual(0);
	});

	test("null-body response: exactly one emit, immediately", async () => {
		const { logger, events } = capture();
		const handler = createWideEventMiddleware(logger)(
			() => new Response(null, { status: HTTP_NO_CONTENT }),
		);

		const response = await handler(new Request("http://localhost/empty"));
		expect(response.status).toBe(HTTP_NO_CONTENT);
		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("expected one event");
		expect(event.status).toBe(HTTP_NO_CONTENT);
		expect(event.path).toBe("/empty");
		expect(event.error).toBeNull();
		// No inbound traceparent: a trace was minted, no parent.
		expect(event.trace_id).toMatch(/^[0-9a-f]{32}$/);
		expect(event.parent_span_id).toBeNull();

		// No second emission can follow a null body.
		await settle();
		expect(events).toHaveLength(1);
	});

	test("thrown handler: rethrows, exactly one emit with status 500 and the projected error", async () => {
		const { logger, events } = capture();
		const handler = createWideEventMiddleware(logger)(() => {
			throw new Error("render exploded");
		});

		let thrown: unknown;
		try {
			await handler(new Request("http://localhost/boom"));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("render exploded");
		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("expected one event");
		expect(event.status).toBe(HTTP_INTERNAL_ERROR);
		expect(event.error).not.toBeNull();
		expect(event.error?.type).toBe("Error");
		expect(event.error?.message).toBe("render exploded");
		expect(event.error?.stack).toContain("render exploded");

		// The throw path must not double-emit later.
		await settle();
		expect(events).toHaveLength(1);
	});

	test("source error mid-stream: exactly one emit, outcome 'errored', error projected, SENT status kept", async () => {
		const { logger, events } = capture();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		// A source that flushes the shell then ERRORS on the next pull — the
		// mid-render failure the identity-transform design emitted nothing for.
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulls === 0) {
					pulls += 1;
					controller.enqueue(encoder.encode("<html>partial"));
					return;
				}
				controller.error(new Error("source blew up mid-stream"));
			},
		});

		const handler = createWideEventMiddleware(logger)(
			() => new Response(body, { status: HTTP_OK, headers: { "content-type": "text/html" } }),
		);
		const response = await handler(
			new Request("http://localhost/todos", { headers: { traceparent: VALID_TRACEPARENT } }),
		);

		// Drain the monitored body: the flushed prefix is delivered verbatim (bytes
		// untouched), then the NEXT read rejects — the source error surfaced
		// downstream. The source emits exactly one chunk before erroring, so two
		// reads suffice (no await-in-loop).
		const reader = response.body?.getReader();
		if (reader === undefined) throw new Error("expected a response body");
		const first = await reader.read();
		const received = first.value === undefined ? "" : decoder.decode(first.value);
		let readError: unknown;
		try {
			await reader.read();
		} catch (error) {
			readError = error;
		}
		await settle();

		expect(received).toBe("<html>partial");
		expect(readError).toBeInstanceOf(Error);
		expect((readError as Error).message).toBe("source blew up mid-stream");
		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("expected one event");
		expect(event.attributes[STREAM_OUTCOME]).toBe("errored");
		expect(event.error).not.toBeNull();
		expect(event.error?.type).toBe("Error");
		expect(event.error?.message).toBe("source blew up mid-stream");
		expect(event.error?.stack).toContain("source blew up mid-stream");
		// The status was ALREADY sent with the shell (200); an errored stream after
		// the flush records the sent status, NOT a synthesized 500.
		expect(event.status).toBe(HTTP_OK);

		// No late second emission.
		await settle();
		expect(events).toHaveLength(1);
	});

	test("consumer cancel mid-stream: exactly one emit, outcome 'cancelled', no error, SENT status kept", async () => {
		const { logger, events } = capture();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		// An open-ended source (never closes) so the only way the stream ends is a
		// downstream cancel — a client disconnecting mid-render.
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(encoder.encode("<html>chunk"));
			},
		});

		const handler = createWideEventMiddleware(logger)(
			() => new Response(body, { status: HTTP_OK, headers: { "content-type": "text/html" } }),
		);
		const response = await handler(
			new Request("http://localhost/todos", { headers: { traceparent: VALID_TRACEPARENT } }),
		);

		const reader = response.body?.getReader();
		if (reader === undefined) throw new Error("expected a response body");
		const first = await reader.read();
		expect(decoder.decode(first.value)).toBe("<html>chunk");
		// Client goes away mid-stream.
		await reader.cancel("client disconnected");
		await settle();

		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("expected one event");
		expect(event.attributes[STREAM_OUTCOME]).toBe("cancelled");
		// A client disconnect is not a server fault: marked by the outcome, not `error`.
		expect(event.error).toBeNull();
		expect(event.status).toBe(HTTP_OK);

		// No late second emission.
		await settle();
		expect(events).toHaveLength(1);
	});

	test("error and cancel racing: still exactly one emit (guard collapses the second terminal)", async () => {
		const { logger, events } = capture();
		const encoder = new TextEncoder();

		// A source that yields the shell, then hangs on the next pull — so a pump
		// `read()` is IN FLIGHT when the consumer cancels, racing the cancel hook
		// against the pending read's resolution.
		let pulls = 0;
		let releaseHang: (() => void) | undefined;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (pulls === 0) {
					pulls += 1;
					controller.enqueue(encoder.encode("<html>chunk"));
					return;
				}
				await new Promise<void>((resolve) => {
					releaseHang = resolve;
				});
				controller.error(new Error("source blew up while cancelling"));
			},
		});

		const handler = createWideEventMiddleware(logger)(
			() => new Response(body, { status: HTTP_OK }),
		);
		const response = await handler(
			new Request("http://localhost/todos", { headers: { traceparent: VALID_TRACEPARENT } }),
		);

		const reader = response.body?.getReader();
		if (reader === undefined) throw new Error("expected a response body");
		await reader.read(); // pump now has an in-flight read into the hung source
		await settle();
		// Cancel (terminal #1) then release the source error (terminal #2) — the two
		// terminal signals race; the `emitted` guard must collapse them to one event.
		const cancelled = reader.cancel("client disconnected");
		releaseHang?.();
		await cancelled.catch(() => undefined);
		await settle();

		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("expected one event");
		// Whichever terminal won, the recorded outcome is one of the two — never a
		// double emission.
		const outcome = event.attributes[STREAM_OUTCOME];
		expect(outcome === "cancelled" || outcome === "errored").toBe(true);
	});

	test("empty (present-but-unwritten) body: pump emits once, outcome 'completed'", async () => {
		const { logger, events } = capture();

		// A body that is present (non-null, so it flows through the pump) but closes
		// with zero bytes — distinct from the null-body path, which never opens a
		// stream. The pump's first read sees `done` and emits "completed".
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});

		const handler = createWideEventMiddleware(logger)(
			() => new Response(body, { status: HTTP_OK }),
		);
		const response = await handler(new Request("http://localhost/empty-stream"));
		const text = await response.text();
		await settle();

		expect(text).toBe("");
		expect(events).toHaveLength(1);
		const event = events[0];
		if (event === undefined) throw new Error("expected one event");
		expect(event.status).toBe(HTTP_OK);
		expect(event.error).toBeNull();
		expect(event.attributes[STREAM_OUTCOME]).toBe("completed");

		// No late second emission.
		await settle();
		expect(events).toHaveLength(1);
	});
});
