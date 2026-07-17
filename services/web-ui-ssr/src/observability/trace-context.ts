// W3C Trace Context (`traceparent`) handling for the SSR wide-event logger.
//
// A hand-rolled, fixed-width parser that MIRRORS the Java implementation
// (packages/java/connect-unary-adapter/.../TraceParent.java + TraceContext.java)
// in its strictness rules, so the two services adopt/mint trace ids identically
// and their wide events correlate on a shared `trace_id`. No OpenTelemetry
// dependency — the deployment is agent-free by design (see docs/wide-events.md);
// the upgrade path is to add an OTel SDK later and feed it the same ids.
//
// The version-`00` format is a fixed 55 ASCII characters:
//
//   00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
//   ^^ ^------------------------------^ ^--------------^ ^^
//   |  trace-id (32 lowercase hex)      parent-id (16)   flags (2)
//   version (2)

const TRACEPARENT_LENGTH = 55;
const TRACE_ID_START = 3;
const TRACE_ID_END = 35;
const PARENT_ID_START = 36;
const PARENT_ID_END = 52;
const FLAGS_START = 53;
const SUPPORTED_VERSION = "00";
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
// Trace-flags minted for a brand-new trace: 01 = sampled/recorded. Flags are
// opaque to us (we make no sampling decisions); an adopted header's flags are
// forwarded verbatim, matching the Java side treating flags as opaque.
const DEFAULT_FLAGS = "01";

// Lowercase-hex encoding of random ids.
const HEX_RADIX = 16;
const HEX_PAD_WIDTH = 2;

const LOWER_HEX_ONLY = /^[0-9a-f]+$/;
const ALL_ZERO = /^0+$/;

/** A parsed inbound `traceparent` header. */
export interface TraceParent {
	readonly traceId: string;
	readonly parentId: string;
	readonly flags: string;
}

/**
 * The trace context adopted for one request: the `traceId` it belongs to, the
 * fresh `spanId` minted for this server's handling of it, the `parentSpanId`
 * (the caller's span, or `null` when this request starts the trace), and the
 * trace `flags`.
 */
export interface TraceContext {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId: string | null;
	readonly flags: string;
}

function isLowerHex(value: string): boolean {
	// The spec mandates lowercase hex; an uppercase digit is invalid.
	return LOWER_HEX_ONLY.test(value);
}

function isAllZero(value: string): boolean {
	return ALL_ZERO.test(value);
}

/**
 * Parses a `traceparent` header value, returning `null` for any
 * absent/malformed/forbidden value (the caller then starts a new trace).
 *
 * Rejection rules (identical to the Java parser): not exactly 55 chars, wrong
 * delimiters, version other than `00`, any non-lowercase-hex digit (the spec
 * mandates lowercase — an uppercase id is invalid), or an all-zero trace-id or
 * parent-id (forbidden by the spec).
 */
export function parseTraceParent(value: string | null | undefined): TraceParent | null {
	if (value === null || value === undefined || value.length !== TRACEPARENT_LENGTH) {
		return null;
	}
	if (value[2] !== "-" || value[TRACE_ID_END] !== "-" || value[PARENT_ID_END] !== "-") {
		return null;
	}
	if (value.slice(0, 2) !== SUPPORTED_VERSION) {
		return null;
	}
	const traceId = value.slice(TRACE_ID_START, TRACE_ID_END);
	const parentId = value.slice(PARENT_ID_START, PARENT_ID_END);
	const flags = value.slice(FLAGS_START, TRACEPARENT_LENGTH);
	if (!isLowerHex(traceId) || !isLowerHex(parentId) || !isLowerHex(flags)) {
		return null;
	}
	if (isAllZero(traceId) || isAllZero(parentId)) {
		return null;
	}
	return { traceId, parentId, flags };
}

/**
 * Generates a lowercase-hex id from `byteCount` cryptographically-random bytes.
 *
 * Uses `crypto.getRandomValues`, which is a member of the base `Crypto`
 * interface exposed on the global scope of BOTH runtimes this module serves —
 * Bun/Node (SSR) and the browser (client RPC interceptor, task iq2.4). It is
 * deliberately NOT `crypto.randomUUID` / `crypto.subtle`: those live on the
 * `SubtleCrypto` surface that browsers gate behind a SECURE CONTEXT, so they are
 * `undefined` when the app is served over plain HTTP (the e2e browser reaches it
 * via `host.docker.internal`). `getRandomValues` carries no such requirement, so
 * the same id minting works isomorphically. This whole module imports nothing —
 * it pulls no server-only dependency into the client bundle.
 */
function randomHex(byteCount: number): string {
	const bytes = new Uint8Array(byteCount);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(HEX_RADIX).padStart(HEX_PAD_WIDTH, "0");
	}
	return hex;
}

/**
 * Resolves the trace context from an inbound `traceparent` header value (may be
 * `null`). A valid header adopts its trace-id, records its parent-id, and mints
 * a fresh span-id; an absent or invalid header starts a brand-new trace.
 */
export function resolveTraceContext(traceparent: string | null | undefined): TraceContext {
	const parsed = parseTraceParent(traceparent);
	if (parsed === null) {
		return {
			traceId: randomHex(TRACE_ID_BYTES),
			spanId: randomHex(SPAN_ID_BYTES),
			parentSpanId: null,
			flags: DEFAULT_FLAGS,
		};
	}
	return {
		traceId: parsed.traceId,
		spanId: randomHex(SPAN_ID_BYTES),
		parentSpanId: parsed.parentId,
		flags: parsed.flags,
	};
}

/**
 * Formats a `traceparent` header to forward to a downstream service. The child
 * hop shares this request's `traceId` and records this server's `spanId` as its
 * parent, so the SSR wide event and the backend wide event correlate on one
 * `trace_id`.
 */
export function formatTraceParent(traceId: string, spanId: string, flags: string): string {
	return `${SUPPORTED_VERSION}-${traceId}-${spanId}-${flags}`;
}

/** The trace-flags minted for a brand-new client trace: `01` (sampled). */
export const DEFAULT_TRACE_FLAGS = DEFAULT_FLAGS;

/**
 * Mints a fresh 32-hex-char (16-byte) trace-id. Used browser-side (task iq2.4)
 * to start one trace per USER ACTION — the client RPCs a browser action issues
 * go straight to the backend, bypassing the SSR middleware, so this is their
 * only trace source.
 */
export function mintTraceId(): string {
	return randomHex(TRACE_ID_BYTES);
}

/**
 * Mints a fresh 16-hex-char (8-byte) span-id — a new span per RPC (the client
 * span recorded as the outbound `traceparent`'s parent-id) and per action root.
 */
export function mintSpanId(): string {
	return randomHex(SPAN_ID_BYTES);
}
