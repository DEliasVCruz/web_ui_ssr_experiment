import { describe, expect, test } from "bun:test";
import { mintTodoId } from "./mutation-ids";

// Canonical lowercase UUIDv7: 8-4-4-4-12 hex, version nibble `7`, variant nibble
// in [89ab], and NO uppercase (dedupe is exact-string — a case-twin would create
// a second row, so minting must be lowercase — 1w9.6 review rule #1).
const UUID_V7_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Number of ids sampled for the uniqueness check, and the hex-char width of the
// leading timestamp field (first UUID group) used for the time-ordering check.
const SAMPLE_COUNT = 1000;
const TIMESTAMP_PREFIX_HEX = 8;

describe("mintTodoId", () => {
	test("is a lowercase canonical UUIDv7", () => {
		const id = mintTodoId();
		expect(id).toMatch(UUID_V7_LOWER);
		// Belt-and-braces: no uppercase hex anywhere (replay must be byte-identical).
		expect(id).toBe(id.toLowerCase());
	});

	test("mints unique ids across calls", () => {
		const ids = new Set(Array.from({ length: SAMPLE_COUNT }, () => mintTodoId()));
		expect(ids.size).toBe(SAMPLE_COUNT);
	});

	test("embeds a time-ordered millisecond timestamp (v7 monotonic-ish)", () => {
		// The leading 48 bits are a big-endian ms timestamp, so an id minted later
		// sorts lexicographically >= one minted earlier (within the same ms they may
		// tie on the timestamp prefix; the assertion is >=, not >).
		const earlier = mintTodoId();
		const later = mintTodoId();
		expect(later.slice(0, TIMESTAMP_PREFIX_HEX) >= earlier.slice(0, TIMESTAMP_PREFIX_HEX)).toBe(
			true,
		);
	});
});
