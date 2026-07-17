import { describe, expect, test } from "bun:test";
import { createWideEventMiddleware } from "./request-logging";
import type { WideEvent } from "./wide-event";
import type { WideEventLogger } from "./wide-event-logger";

// Lifecycle invariants of the wide-event middleware: exactly ONE emission per
// request on every outcome (streamed success, null body, thrown handler), the
// streamed emission happening at stream COMPLETION (not handler return), and
// response bytes passing through unchanged.

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_INTERNAL_ERROR = 500;
const SETTLE_MS = 25;

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
});
