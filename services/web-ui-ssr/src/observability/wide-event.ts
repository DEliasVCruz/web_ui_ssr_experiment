// The wide-event schema for the SSR rendering server — ONE structured JSON line
// per HTTP request, emitted at request completion. This TypeScript type is a
// faithful mirror of the Java `WideEvent` (packages/java/connect-unary-adapter,
// the schema's source of truth); see docs/wide-events.md. Same key set, types,
// snake_case naming, and nullability, so both services' logs are queryable as
// one stream.
//
// `connect_code` and `rpc_method` are part of the shared key set but are always
// `null` here: the rendering server serves HTML routes, not Connect RPCs (that
// enrichment happens only on the Java adapter). SSR-specific detail belongs in
// the free-form `attributes` map (the schema's sanctioned extension point),
// keeping the top-level key set identical across services.

/** The `error` object of a wide event: an exception projected into the schema. */
export interface WideEventError {
	readonly type: string;
	readonly message: string;
	readonly stack: string | null;
}

/**
 * A single wide event. Mutable by design: the middleware seeds the trace/HTTP
 * fields at the request boundary and fills timing + final status at completion
 * (mirroring the Java filter's build-then-finalize lifecycle).
 */
export interface WideEvent {
	trace_id: string;
	span_id: string;
	parent_span_id: string | null;
	timestamp: string;
	duration_ms: number;
	http_method: string;
	path: string;
	status: number;
	connect_code: string | null;
	rpc_method: string | null;
	component: string;
	error: WideEventError | null;
	attributes: Record<string, string>;
}

// Container log drivers (Docker's json-file, journald) chunk a single stdout
// write at ~16KB and each chunk is re-emitted as its own log record, which would
// split one wide-event JSON line into several unparseable fragments. An error
// stack is the only unbounded field, so it is capped twice: to the most
// diagnostically useful frames, and to a hard byte ceiling well under 16KB.
export const MAX_STACK_FRAMES = 20;
export const MAX_STACK_BYTES = 8192;

/**
 * Caps an error stack to at most {@link MAX_STACK_FRAMES} frames (keeping the
 * leading message/header lines) and then to {@link MAX_STACK_BYTES} bytes,
 * appending a truncation marker whenever it trims. Returns `null` for an absent
 * or empty stack (mirrors the Java error schema's nullable `stack`).
 */
export function capStack(stack: string | null | undefined): string | null {
	if (stack === null || stack === undefined || stack.length === 0) {
		return null;
	}
	const lines = stack.split("\n");
	const kept: string[] = [];
	let frames = 0;
	let framesTruncated = false;
	for (const line of lines) {
		if (/^\s*at\s/.test(line)) {
			if (frames >= MAX_STACK_FRAMES) {
				framesTruncated = true;
				break;
			}
			frames++;
		}
		kept.push(line);
	}
	let result = kept.join("\n");
	if (framesTruncated) {
		result += `\n\t... (stack truncated to ${String(MAX_STACK_FRAMES)} frames)`;
	}
	// Hard byte ceiling. Stacks are effectively ASCII, so a character slice keeps
	// the byte length within the ceiling; the marker is short enough that the
	// result stays comfortably under 16KB even after it is appended.
	if (new TextEncoder().encode(result).length > MAX_STACK_BYTES) {
		result = `${result.slice(0, MAX_STACK_BYTES)}\n\t... (stack truncated to ${String(MAX_STACK_BYTES)} bytes)`;
	}
	return result;
}

/**
 * Projects a thrown value into the wide-event error schema: `type` is the error
 * name, `message` its message (falling back to the name when empty), and `stack`
 * the capped stack trace. Non-`Error` throws are captured structurally too, so
 * the field is never lost.
 */
export function toWideEventError(thrown: unknown): WideEventError {
	if (thrown instanceof Error) {
		const name = thrown.name.length > 0 ? thrown.name : thrown.constructor.name;
		return {
			type: name,
			message: thrown.message.length > 0 ? thrown.message : name,
			stack: capStack(thrown.stack),
		};
	}
	return {
		type: typeof thrown,
		message: String(thrown),
		stack: null,
	};
}
