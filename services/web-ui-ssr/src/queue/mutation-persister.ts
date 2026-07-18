import { type DehydratedState, dehydrate, hydrate, type QueryClient } from "@tanstack/solid-query";
import { del, get, set } from "idb-keyval";

// Persisted offline mutation queue (task 1w9.4 §4.2). The 1w9.3 per-query
// persister covers QUERIES only (it wraps queryFn); paused MUTATIONS die with the
// document. This module makes them survive a reload — the survival proof of this
// task — with a small custom paused-mutation store rather than the full
// persistQueryClient (which would also take over query persistence and fight the
// per-query persister already in place; design §4.2 sanctioned a custom store).
//
// Mechanism: TanStack's own dehydrate/hydrate serialize a mutation's key + state
// (its variables, incl. the client id and captured `__trace`) — the exact primitive
// persistQueryClient uses. We dehydrate ONLY queued mutations (queries excluded,
// so this never double-persists the query cache and never persists optimistic
// setQueryData writes — F8: the persisted cache stays server-truth-only) and store
// them under one IndexedDB key. On startup we hydrate them back and resume.
//
// CLIENT-ONLY: imports idb-keyval (touches indexedDB) and uses window — never
// import from the server entry (entry-client is the sole importer, like
// query-persister).

const STORE_KEY = "web-ui-paused-mutations";

// Mutations that have been PAUSED at least once — i.e. genuine offline-queued
// writes. A mutation joins this set the moment it is observed paused and stays a
// member for its lifetime. Two invariants ride on it:
//   * KEEP-UNTIL-SUCCESS (task 1w9.4 review F2): we persist a queued write for as
//     long as it is still `pending` — paused OR resumed-and-in-flight — and drop it
//     from the store ONLY when it reaches a terminal state. The previous
//     isPaused-only filter deleted the entry the instant a mutation resumed
//     (isPaused flips false synchronously, before the RPC completes), so a
//     tab-close between resume and success lost the write forever (at-most-once,
//     contradicting the banner's "saved and will sync"). Membership here decouples
//     "should still persist" from "is currently paused", closing that window.
//   * OFFLINE-ONLY (design F8): a purely-online in-flight RPC is never paused, so
//     it never joins this set and is never persisted — the queue holds offline
//     writes only, exactly as designed.
const queued = new WeakSet();

// Chain IndexedDB writes so rapid mutation-cache events (create → pause → resume)
// can never land their set/del out of order and leave a stale queue on disk.
let writeChain: Promise<void> = Promise.resolve();

/** Mark every currently-paused mutation as a queued write (idempotent). */
function trackQueued(queryClient: QueryClient): void {
	for (const mutation of queryClient.getMutationCache().getAll()) {
		if (mutation.state.isPaused) {
			queued.add(mutation);
		}
	}
}

async function persist(queryClient: QueryClient): Promise<void> {
	const { mutations } = dehydrate(queryClient, {
		// Keep-until-success (F2): dehydrate a queued write while it is still
		// `pending` — this covers BOTH the paused-offline state (status "pending",
		// isPaused true) AND the resumed-and-flushing state (status "pending",
		// isPaused false). It leaves the store the moment it settles terminally
		// (status !== "pending"): a SUCCESS removes the now-durable write; a terminal
		// ERROR drops it rather than retry on every future load (proper terminal
		// -error handling is F7 / 1w9.5). Because the entry survives the entire
		// resume→pending→success window, a crash mid-flush no longer loses the write
		// — and replay is safe (creates carry the client-minted idempotent id;
		// edits/toggles/deletes are idempotent by nature), so this is now genuinely
		// at-least-once, not at-most-once.
		shouldDehydrateMutation: (mutation) =>
			queued.has(mutation) && mutation.state.status === "pending",
		// …and NO queries (the per-query persister owns those; excluding them keeps
		// optimistic writes out of the persisted store — design F8).
		shouldDehydrateQuery: () => false,
	});
	if (mutations.length === 0) {
		await del(STORE_KEY);
		return;
	}
	// Drop the onMutate `context` (a stale-after-reload cache snapshot the replay
	// handlers never read) so the store stays lean and cleanly serializable; the
	// load-bearing `variables` (id, title, __trace) live in `state`, untouched.
	const lean = mutations.map((mutation) => ({
		...mutation,
		state: { ...mutation.state, context: undefined },
	}));
	await set(STORE_KEY, JSON.stringify({ mutations: lean }));
}

function schedulePersist(queryClient: QueryClient): void {
	writeChain = writeChain.then(() => persist(queryClient)).catch(() => undefined);
}

async function restore(queryClient: QueryClient): Promise<void> {
	const raw = await get<string>(STORE_KEY);
	if (typeof raw !== "string") return;
	try {
		const state = JSON.parse(raw) as DehydratedState;
		// Rebuilds each paused mutation in the cache; its mutationFn + reconciliation
		// handlers (and its serialization scope) come from setMutationDefaults(key)
		// (register those FIRST).
		hydrate(queryClient, state);
	} catch {
		// Corrupt payload: discard rather than wedge every future load.
		await del(STORE_KEY);
	}
}

/**
 * Installs the offline mutation queue on the client query client. Registering the
 * mutation defaults must have run FIRST — rehydrated mutations resolve their
 * functions AND their serialization scope by key. Then, in order:
 *   1. subscribe so queued mutations are persisted to IndexedDB and kept there
 *      until they terminally succeed (keep-until-success, F2);
 *   2. resume the queue whenever connectivity returns (`online` event);
 *   3. restore any mutations persisted by a previous document and resume them —
 *      the reload-survival flush. Replay is SERIALIZED (FIFO) because every
 *      offline-capable mutation shares one queue scope (see mutation-defaults.ts,
 *      F1) — NOT because resumePausedMutations is ordered (it is Promise.all).
 * Awaiting the returned promise means the startup restore+resume has been kicked.
 */
export async function installOfflineMutationQueue(queryClient: QueryClient): Promise<void> {
	queryClient.getMutationCache().subscribe(() => {
		// Track BEFORE persisting: a mutation observed paused here stays persisted
		// after it resumes (isPaused → false, still pending) until it succeeds.
		trackQueued(queryClient);
		schedulePersist(queryClient);
	});
	window.addEventListener("online", () => {
		void queryClient.resumePausedMutations();
	});
	await restore(queryClient);
	// Restored mutations arrive paused (status "pending", isPaused true). Track them
	// explicitly here — synchronously, while they are still paused and BEFORE the
	// resume flips isPaused false — so keep-until-success covers them regardless of
	// how the `added` notifications are batched. Resume then flushes them (serialized
	// by the queue scope), and each survivor's entry is removed only on its terminal
	// success.
	trackQueued(queryClient);
	await queryClient.resumePausedMutations();
}
