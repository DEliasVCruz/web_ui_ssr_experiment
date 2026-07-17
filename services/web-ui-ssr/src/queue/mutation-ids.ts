// Client-generated todo ids for the offline queue (task 1w9.4). A create mints
// its FINAL id here, at enqueue, and sends it in `CreateTodoRequest.id`; the
// backend persists it verbatim (idempotent first-write-wins). This collapses the
// old `temp-N` reconciliation: the optimistic row already carries its real id, so
// identity survives the settle refetch and an offline-queued create replays with
// a byte-identical id (exact-string dedupe → a re-sent queue entry is a no-op).
//
// Two non-negotiables from the 1w9.6 backend review, both pinned by tests:
//   1. LOWERCASE canonical UUIDv7. The uuid protovalidate rule accepts uppercase
//      hex, but storage is case-sensitive text — a case-twin spelling of the same
//      uuid creates a DISTINCT row. Replay must be byte-identical, so we mint
//      lowercase and never upper-case an id anywhere.
//   2. Minted via `crypto.getRandomValues`, NOT `crypto.randomUUID`. randomUUID
//      lives on the secure-context-gated surface and is `undefined` over plain
//      HTTP (the e2e browser reaches the app via host.docker.internal) — the very
//      reason the superseded code used a `temp-N` counter. getRandomValues is on
//      the base Crypto interface in every context, so id minting is isomorphic.
//
// UUIDv7 layout (RFC 9562): 48-bit big-endian Unix-ms timestamp, 4-bit version
// (0111), 12 random bits, 2-bit variant (10), 62 random bits. The embedded
// millisecond timestamp makes ids time-ordered and collision-free across reloads
// — strictly better than a timestamp+counter for a persisted queue.

const UUID_BYTES = 16;
const HEX_RADIX = 16;
const HEX_PAD_WIDTH = 2;
// One octet's worth of values — modulo (not `& 0xff`) so extracting the high
// timestamp bytes is safe: a ms timestamp exceeds 2^32 and bitwise `&` would
// coerce to int32 and corrupt them.
const BYTE_RADIX = 256;
// The timestamp occupies the leading 6 bytes (48 bits), big-endian.
const TIMESTAMP_BYTES = 6;
// Version nibble (7) into byte 6; variant bits (0b10) into byte 8.
const VERSION_BYTE_INDEX = 6;
const VARIANT_BYTE_INDEX = 8;
const LOW_NIBBLE_MASK = 0x0f;
const VERSION_7_HIGH_NIBBLE = 0x70;
const VARIANT_CLEAR_MASK = 0x3f;
const VARIANT_RFC_HIGH_BITS = 0x80;
// Canonical group boundaries as hex-char offsets: 8-4-4-4-12.
const GROUP1_END = 8;
const GROUP2_END = 12;
const GROUP3_END = 16;
const GROUP4_END = 20;

/**
 * Mints a lowercase canonical UUIDv7 string for a client-supplied todo id. Pure
 * (aside from `Date.now`/`crypto`), SSR-safe, and never throws in an insecure
 * context. The returned value is the id sent on the wire AND the replay dedupe
 * key — always use it verbatim (never re-case it).
 */
export function mintTodoId(): string {
	const bytes = new Uint8Array(UUID_BYTES);
	crypto.getRandomValues(bytes);

	// 48-bit millisecond timestamp, big-endian, into the leading bytes (overwrites
	// the random fill there). Modulo/division, not bit-shift — a ms timestamp
	// exceeds 32 bits.
	let remaining = Date.now();
	for (let pos = TIMESTAMP_BYTES - 1; pos >= 0; pos -= 1) {
		bytes[pos] = remaining % BYTE_RADIX;
		remaining = Math.floor(remaining / BYTE_RADIX);
	}

	// Version 7 in the high nibble of byte 6; variant 0b10 in the high bits of
	// byte 8. `?? 0` satisfies noUncheckedIndexedAccess (the indices always exist
	// for a length-16 array).
	bytes[VERSION_BYTE_INDEX] =
		((bytes[VERSION_BYTE_INDEX] ?? 0) & LOW_NIBBLE_MASK) | VERSION_7_HIGH_NIBBLE;
	bytes[VARIANT_BYTE_INDEX] =
		((bytes[VARIANT_BYTE_INDEX] ?? 0) & VARIANT_CLEAR_MASK) | VARIANT_RFC_HIGH_BITS;

	// Lowercase hex, then canonical dashes. `for…of` yields `number` (never
	// `undefined`), so no indexed-access guard is needed here.
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(HEX_RADIX).padStart(HEX_PAD_WIDTH, "0");
	}
	return [
		hex.slice(0, GROUP1_END),
		hex.slice(GROUP1_END, GROUP2_END),
		hex.slice(GROUP2_END, GROUP3_END),
		hex.slice(GROUP3_END, GROUP4_END),
		hex.slice(GROUP4_END),
	].join("-");
}
