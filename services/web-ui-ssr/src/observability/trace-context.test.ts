import { describe, expect, test } from "bun:test";
import {
	formatTraceParent,
	parseTraceParent,
	resolveTraceContext,
	type TraceParent,
} from "./trace-context";

// Matrix mirrors the Java TraceParentTest so both parsers accept/reject
// identically — the precondition for cross-service trace_id correlation.
const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";

const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_32 = /^[0-9a-f]{32}$/;

function parsed(value: string): TraceParent {
	const result = parseTraceParent(value);
	if (result === null) {
		throw new Error(`expected a valid traceparent for ${value}`);
	}
	return result;
}

describe("parseTraceParent", () => {
	test("parses a valid traceparent", () => {
		const result = parsed(VALID);
		expect(result.traceId).toBe(TRACE_ID);
		expect(result.parentId).toBe(PARENT_ID);
		expect(result.flags).toBe("01");
	});

	test("accepts flags other than sampled (00)", () => {
		expect(parsed("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00").flags).toBe("00");
	});

	test("rejects null and undefined", () => {
		expect(parseTraceParent(null)).toBeNull();
		expect(parseTraceParent(undefined)).toBeNull();
	});

	test("rejects wrong length", () => {
		expect(parseTraceParent("00-abc-def-01")).toBeNull();
		expect(parseTraceParent(`${VALID}0`)).toBeNull();
	});

	test("rejects bad delimiters", () => {
		expect(parseTraceParent("00_4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
	});

	test("rejects unsupported version", () => {
		expect(parseTraceParent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
		expect(parseTraceParent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
	});

	test("rejects uppercase hex (spec mandates lowercase)", () => {
		expect(parseTraceParent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01")).toBeNull();
	});

	test("rejects non-hex digits", () => {
		expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e473g-00f067aa0ba902b7-01")).toBeNull();
	});

	test("rejects an all-zero trace-id", () => {
		expect(parseTraceParent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
	});

	test("rejects an all-zero parent-id", () => {
		expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
	});
});

describe("resolveTraceContext", () => {
	test("adopts a valid inbound header and mints a fresh span", () => {
		const context = resolveTraceContext(VALID);
		expect(context.traceId).toBe(TRACE_ID);
		expect(context.parentSpanId).toBe(PARENT_ID);
		expect(context.spanId).toMatch(HEX_16);
		expect(context.spanId).not.toBe(PARENT_ID);
		expect(context.flags).toBe("01");
	});

	test("starts a new trace for an absent header", () => {
		const context = resolveTraceContext(null);
		expect(context.traceId).toMatch(HEX_32);
		expect(context.spanId).toMatch(HEX_16);
		expect(context.parentSpanId).toBeNull();
		expect(context.flags).toBe("01");
	});

	test("starts a new trace for an invalid header", () => {
		const context = resolveTraceContext("not-a-traceparent");
		expect(context.traceId).toMatch(HEX_32);
		expect(context.parentSpanId).toBeNull();
	});

	test("mints unique ids across requests (cryptographically random)", () => {
		const a = resolveTraceContext(null);
		const b = resolveTraceContext(null);
		expect(a.traceId).not.toBe(b.traceId);
		expect(a.spanId).not.toBe(b.spanId);
	});
});

describe("formatTraceParent", () => {
	test("formats a forwardable child traceparent that round-trips through parse", () => {
		const context = resolveTraceContext(VALID);
		const forwarded = formatTraceParent(context.traceId, context.spanId, context.flags);
		expect(forwarded).toBe(`00-${TRACE_ID}-${context.spanId}-01`);

		// The downstream service (same strict parser) adopts our trace and records
		// our span as its parent — the correlation invariant.
		const downstream = parsed(forwarded);
		expect(downstream.traceId).toBe(TRACE_ID);
		expect(downstream.parentId).toBe(context.spanId);
	});
});
