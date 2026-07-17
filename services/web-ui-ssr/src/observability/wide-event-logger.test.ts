import { describe, expect, test } from "bun:test";
import type { WideEvent } from "./wide-event";
import { createWideEventLogger } from "./wide-event-logger";

const SAMPLE_STATUS = 200;
const SAMPLE_DURATION_MS = 7;

/** A pino destination that captures every written line in memory. */
function capturingLogger(): { emit: (event: WideEvent) => void; lines: () => string[] } {
	const chunks: string[] = [];
	const logger = createWideEventLogger({
		write(chunk: string): void {
			chunks.push(chunk);
		},
	});
	return {
		emit: (event) => {
			logger.emit(event);
		},
		lines: () =>
			chunks
				.join("")
				.split("\n")
				.filter((line) => line.length > 0),
	};
}

function sampleEvent(overrides: Partial<WideEvent> = {}): WideEvent {
	return {
		trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
		span_id: "00f067aa0ba902b7",
		parent_span_id: null,
		timestamp: "2026-07-17T00:00:00.123Z",
		duration_ms: SAMPLE_DURATION_MS,
		http_method: "GET",
		path: "/todos",
		status: SAMPLE_STATUS,
		connect_code: null,
		rpc_method: null,
		component: "web-ui-ssr",
		error: null,
		attributes: {},
		...overrides,
	};
}

describe("createWideEventLogger", () => {
	test("emits exactly one JSON line carrying the schema fields, with explicit nulls", () => {
		const { emit, lines } = capturingLogger();
		emit(sampleEvent());

		const emitted = lines();
		expect(emitted).toHaveLength(1);

		const line = emitted[0];
		if (line === undefined) {
			throw new Error("expected one emitted line");
		}
		interface EmittedLine {
			trace_id: string;
			span_id: string;
			parent_span_id: string | null;
			connect_code: string | null;
			rpc_method: string | null;
			error: unknown;
			component: string;
			status: number;
			duration_ms: number;
		}
		const parsed = JSON.parse(line) as EmittedLine;

		expect(parsed.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(parsed.span_id).toBe("00f067aa0ba902b7");
		expect(parsed.parent_span_id).toBeNull();
		expect(parsed.connect_code).toBeNull();
		expect(parsed.rpc_method).toBeNull();
		expect(parsed.error).toBeNull();
		expect(parsed.component).toBe("web-ui-ssr");
		expect(parsed.status).toBe(SAMPLE_STATUS);
		expect(parsed.duration_ms).toBe(SAMPLE_DURATION_MS);

		// Explicit nulls survive; no LogLayer empty-message artifact.
		expect(line).toContain('"parent_span_id":null');
		expect(Object.keys(parsed)).not.toContain("msg");
	});

	test("redacts sensitive attribute keys", () => {
		const { emit, lines } = capturingLogger();
		emit(sampleEvent({ attributes: { authorization: "Bearer secret", route_id: "/todos" } }));

		const line = lines()[0];
		if (line === undefined) {
			throw new Error("expected one emitted line");
		}
		expect(line).toContain("[REDACTED]");
		expect(line).not.toContain("Bearer secret");
		expect(line).toContain("/todos");
	});
});
