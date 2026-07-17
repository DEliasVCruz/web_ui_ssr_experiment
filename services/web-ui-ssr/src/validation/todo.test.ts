import { describe, expect, test } from "bun:test";
import {
	createTodoRequestSchema,
	updateTodoRequestSchema,
} from "@web-ui-poc/rpc/gen/jsonschema/schemas";
import { type } from "arktype";
import {
	detailsBounds,
	MAX_DETAILS_LENGTH,
	MAX_TITLE_LENGTH,
	MIN_TITLE_LENGTH,
	titleBounds,
	validateDetails,
	validateTitle,
} from "./todo";

// These tests are deliberately anchored to the CURRENT generated schema (read
// straight from the wrapped module), never to hard-coded 1/100. That is what
// makes constraint drift break the build: change min_len/max_len in
// todo.proto, run `bun run generate`, and both the schema bounds AND the arktype
// Type derived from them move together — so if the Type ever stopped enforcing
// the proto's numbers, the boundary assertions below would fail.
const schemaMin = createTodoRequestSchema.properties.title.minLength;
const schemaMax = createTodoRequestSchema.properties.title.maxLength;

const atMin = "a".repeat(MIN_TITLE_LENGTH);
const atMax = "a".repeat(MAX_TITLE_LENGTH);
const overMax = `${atMax}a`;

function isRejected(value: string): boolean {
	return titleBounds(value) instanceof type.errors;
}

describe("title validation is derived from the proto constraints", () => {
	test("the exported bounds match the generated JSON Schema", () => {
		expect(MIN_TITLE_LENGTH).toBe(schemaMin);
		expect(MAX_TITLE_LENGTH).toBe(schemaMax);
	});

	test("the arktype Type enforces exactly the generated bounds", () => {
		// Upper bound: length == max passes, length == max + 1 fails.
		expect(isRejected(atMax)).toBe(false);
		expect(isRejected(overMax)).toBe(true);
		// Lower bound: an empty string is below min (min is 1) and must fail.
		expect(isRejected("")).toBe(true);
	});

	test("validateTitle maps failures to human-readable messages", () => {
		expect(validateTitle("")).toBe("Title is required");
		expect(validateTitle("   ")).toBe("Title is required");
		expect(validateTitle(overMax)).toBe(
			`Title must be at most ${String(MAX_TITLE_LENGTH)} characters`,
		);
	});

	test("validateTitle accepts titles within the bounds", () => {
		// Fixtures are derived from the bounds (min- and max-length strings) so
		// they stay valid under any drift, never assuming a specific max.
		expect(validateTitle(atMin)).toBeUndefined();
		expect(validateTitle(atMax)).toBeUndefined();
	});
});

// Details validation, likewise anchored to the CURRENT generated schema (the
// UpdateTodoRequest form; create and update carry the same details bound). The
// key difference from title: details has an upper bound but NO lower bound —
// the empty string is legal, because "" is the deliberate CLEAR value under the
// proto's explicit-presence semantics.
const detailsSchemaMax = updateTodoRequestSchema.properties.details.maxLength;

const detailsAtMax = "d".repeat(MAX_DETAILS_LENGTH);
const detailsOverMax = `${detailsAtMax}d`;

function isDetailsRejected(value: string): boolean {
	return detailsBounds(value) instanceof type.errors;
}

describe("details validation is derived from the proto constraints", () => {
	test("the exported max bound matches the generated JSON Schema", () => {
		expect(MAX_DETAILS_LENGTH).toBe(detailsSchemaMax);
	});

	test("the arktype Type enforces the max and admits the empty string", () => {
		// Upper bound: length == max passes, length == max + 1 fails.
		expect(isDetailsRejected(detailsAtMax)).toBe(false);
		expect(isDetailsRejected(detailsOverMax)).toBe(true);
		// No lower bound: the empty string (the clear value) must be accepted.
		expect(isDetailsRejected("")).toBe(false);
	});

	test("validateDetails maps over-length to a human-readable message", () => {
		expect(validateDetails(detailsOverMax)).toBe(
			`Details must be at most ${String(MAX_DETAILS_LENGTH)} characters`,
		);
	});

	test("validateDetails accepts empty and within-bounds details", () => {
		// Empty string is the deliberate clear path — must be valid.
		expect(validateDetails("")).toBeUndefined();
		expect(validateDetails("Some notes")).toBeUndefined();
		expect(validateDetails(detailsAtMax)).toBeUndefined();
	});
});
