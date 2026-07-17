import { describe, expect, test } from "bun:test";
import {
	capStack,
	MAX_STACK_BYTES,
	MAX_STACK_FRAMES,
	toWideEventError,
	type WideEvent,
} from "./wide-event";

// A stack far deeper than the frame cap, so the truncation path is exercised.
const DEEP_FRAME_COUNT = 50;
// The byte-cap marker adds a few bytes past the ceiling; allow for it.
const MARKER_ALLOWANCE = 64;

function frameCount(stack: string): number {
	return stack.split("\n").filter((line) => /^\s*at\s/.test(line)).length;
}

describe("capStack", () => {
	test("returns null for absent or empty stacks", () => {
		expect(capStack(undefined)).toBeNull();
		expect(capStack(null)).toBeNull();
		expect(capStack("")).toBeNull();
	});

	test("keeps a short stack intact", () => {
		const stack = "Error: boom\n    at a (f.ts:1:1)\n    at b (f.ts:2:2)";
		expect(capStack(stack)).toBe(stack);
	});

	test("caps a deep stack to MAX_STACK_FRAMES frames plus a marker", () => {
		const frames = Array.from(
			{ length: DEEP_FRAME_COUNT },
			(_, i) => `    at frame${String(i)} (f.ts:${String(i)}:1)`,
		);
		const stack = `Error: deep\n${frames.join("\n")}`;
		const capped = capStack(stack);
		expect(capped).not.toBeNull();
		if (capped === null) {
			throw new Error("unreachable");
		}
		// TEETH: without the frame cap all 50 frames would survive.
		expect(frameCount(capped)).toBe(MAX_STACK_FRAMES);
		expect(capped).toContain(`... (stack truncated to ${String(MAX_STACK_FRAMES)} frames)`);
	});

	test("caps a pathologically long single frame to the byte ceiling", () => {
		const huge = "x".repeat(MAX_STACK_BYTES * 2);
		const stack = `Error: big\n    at ${huge} (f.ts:1:1)`;
		const capped = capStack(stack);
		expect(capped).not.toBeNull();
		if (capped === null) {
			throw new Error("unreachable");
		}
		expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(
			MAX_STACK_BYTES + MARKER_ALLOWANCE,
		);
		expect(capped).toContain("bytes");
	});

	test("caps a multibyte-heavy stack by ENCODED bytes without splitting surrogate pairs", () => {
		// Each astral emoji is 2 UTF-16 units but 4 UTF-8 bytes: a naive
		// String.slice(0, MAX_STACK_BYTES) would leave ~2x the byte budget. The
		// cap must count encoded bytes and never cut a surrogate pair in half.
		const emoji = "\u{1F4A5}"; // 💥
		const stack = `Error: multibyte\n    at ${emoji.repeat(MAX_STACK_BYTES)} (f.ts:1:1)`;
		const capped = capStack(stack);
		expect(capped).not.toBeNull();
		if (capped === null) {
			throw new Error("unreachable");
		}
		const encodedLength = new TextEncoder().encode(capped).length;
		expect(encodedLength).toBeLessThanOrEqual(MAX_STACK_BYTES + MARKER_ALLOWANCE);
		expect(capped).toContain("bytes");
		// Well-formedness: a lone surrogate does not survive an encode/decode
		// round-trip (TextEncoder replaces it with U+FFFD), so equality here
		// proves no surrogate pair was split by the cap.
		const roundTrip = new TextDecoder().decode(new TextEncoder().encode(capped));
		expect(roundTrip).toBe(capped);
	});
});

describe("toWideEventError", () => {
	test("projects an Error into the schema with a capped stack", () => {
		const error = new TypeError("bad value");
		const projected = toWideEventError(error);
		expect(projected.type).toBe("TypeError");
		expect(projected.message).toBe("bad value");
		expect(projected.stack).toContain("TypeError: bad value");
	});

	test("falls back to the error name when the message is empty", () => {
		// Construct with a placeholder then blank the message: `new Error("")`
		// trips biome's useErrorMessage, and the fallback needs an empty message.
		const empty = new Error("placeholder");
		empty.message = "";
		const projected = toWideEventError(empty);
		expect(projected.type).toBe("Error");
		expect(projected.message).toBe("Error");
	});

	test("captures non-Error throws structurally", () => {
		const projected = toWideEventError("kaboom");
		expect(projected.type).toBe("string");
		expect(projected.message).toBe("kaboom");
		expect(projected.stack).toBeNull();
	});
});

describe("wide-event serialization", () => {
	test("preserves snake_case keys and explicit nulls (no undefined)", () => {
		const event: WideEvent = {
			trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
			span_id: "00f067aa0ba902b7",
			parent_span_id: null,
			timestamp: "2026-07-17T00:00:00.123Z",
			duration_ms: 7,
			http_method: "GET",
			path: "/todos",
			status: 200,
			connect_code: null,
			rpc_method: null,
			component: "web-ui-ssr",
			error: null,
			attributes: {},
		};
		const line = JSON.stringify(event);
		expect(line).toContain('"parent_span_id":null');
		expect(line).toContain('"connect_code":null');
		expect(line).toContain('"rpc_method":null');
		expect(line).toContain('"error":null');
		expect(line).toContain('"attributes":{}');
		expect(line).not.toContain("undefined");

		// Exactly the Java wide-event key set (docs/wide-events.md), snake_case.
		expect(Object.keys(JSON.parse(line) as Record<string, unknown>).sort()).toEqual(
			[
				"attributes",
				"component",
				"connect_code",
				"duration_ms",
				"error",
				"http_method",
				"parent_span_id",
				"path",
				"rpc_method",
				"span_id",
				"status",
				"timestamp",
				"trace_id",
			].sort(),
		);
	});
});
