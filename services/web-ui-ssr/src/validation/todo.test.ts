import { describe, expect, test } from "bun:test";
import { createTodoRequestSchema } from "@web-ui-poc/rpc/gen/jsonschema/schemas";
import { type } from "arktype";
import { MAX_TITLE_LENGTH, MIN_TITLE_LENGTH, titleBounds, validateTitle } from "./todo";

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
