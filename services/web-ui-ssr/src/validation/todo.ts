import { jsonSchemaToType } from "@ark/json-schema";
import {
	createTodoRequestSchema,
	updateTodoRequestSchema,
} from "@web-ui-poc/rpc/gen/jsonschema/schemas";
import { type } from "arktype";

// The title field's JSON Schema, derived from the proto's buf.validate rules
// (min_len/max_len -> minLength/maxLength) at `bun run generate` time. Because
// the generated module is exported `as const`, these bounds are literal types,
// so a constraint change in todo.proto flows through regeneration into this file
// and breaks any test/behaviour that assumed the old numbers.
const titleSchema = createTodoRequestSchema.properties.title;

/** Max title length, straight from the proto constraint (currently 100). */
export const MAX_TITLE_LENGTH = titleSchema.maxLength;
/** Min title length, straight from the proto constraint (currently 1). */
export const MIN_TITLE_LENGTH = titleSchema.minLength;

/**
 * The proto-derived length validator: an arktype Type built from the generated
 * JSON Schema via @ark/json-schema. This is the single source of truth for the
 * bounds (see todo.validation.test.ts, which asserts it enforces exactly
 * MIN/MAX). Constructed at module scope — pure, no browser APIs — so it is safe
 * under SSR and hydration.
 */
export const titleBounds = jsonSchemaToType(titleSchema);

/**
 * Validates a raw (untrimmed) title for the create form. Composes the
 * proto-derived length bounds with a UI-only trimmed-non-empty rule that mirrors
 * the backend's whitespace-only rejection, and maps arktype's failures to
 * human-readable messages.
 *
 * Returns the message string on failure, or `undefined` when valid — the shape
 * @tanstack/solid-form's field validators expect.
 */
export function validateTitle(value: string): string | undefined {
	// UI mirror of the backend rule: a whitespace-only (or empty) title is
	// treated as missing. Kept ahead of the length check so the message is the
	// friendly "required" rather than a length complaint.
	if (value.trim() === "") {
		return "Title is required";
	}
	const result = titleBounds(value);
	if (result instanceof type.errors) {
		// After the trim guard the only reachable length failure is the upper
		// bound; MIN is only hit if the proto min_len ever exceeds 1.
		return value.length > MAX_TITLE_LENGTH
			? `Title must be at most ${String(MAX_TITLE_LENGTH)} characters`
			: `Title must be at least ${String(MIN_TITLE_LENGTH)} characters`;
	}
	return undefined;
}

// The details field's JSON Schema, from the UpdateTodoRequest proto (the edit
// form issues an UpdateTodo). Unlike title, details carries a maxLength (1000)
// but NO minLength — the empty string is legal and is the deliberate "clear"
// value (explicit presence: an omitted field keeps stored details, a set `""`
// clears them). As with title, the bound is a literal type off the generated
// `as const` module, so a proto max_len change flows through regeneration and
// breaks any test asserting the old number.
const detailsSchema = updateTodoRequestSchema.properties.details;

/** Max details length, straight from the proto constraint (currently 1000). */
export const MAX_DETAILS_LENGTH = detailsSchema.maxLength;

/**
 * The proto-derived length validator for details: an arktype Type built from the
 * generated JSON Schema. Single source of truth for the upper bound (see
 * todo.test.ts). Constructed at module scope — pure, SSR/hydration safe.
 */
export const detailsBounds = jsonSchemaToType(detailsSchema);

/**
 * Validates raw details text for the edit form. Details have no lower bound, so
 * the empty string is always valid (it is the clear mechanism); only the proto's
 * maxLength can fail. Returns the message string on failure, or `undefined` when
 * valid — the shape @tanstack/solid-form's field validators expect.
 *
 * Accepts `undefined` and treats it as "" (valid): the `{...todo}` spread in the
 * query layer drops an unset explicit-presence details field, so a never-set
 * todo reads `undefined` at runtime despite the generated `string` type. The
 * editor normalises to "" at its boundary, but the validator is defensive too —
 * an undefined value must never surface a nonsense over-length message.
 */
export function validateDetails(value: string | undefined): string | undefined {
	const result = detailsBounds(value ?? "");
	if (result instanceof type.errors) {
		return `Details must be at most ${String(MAX_DETAILS_LENGTH)} characters`;
	}
	return undefined;
}
