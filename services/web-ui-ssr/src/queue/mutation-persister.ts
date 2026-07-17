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
// persistQueryClient uses. We dehydrate ONLY paused mutations (queries excluded,
// so this never double-persists the query cache and never persists optimistic
// setQueryData writes — F8: the persisted cache stays server-truth-only) and store
// them under one IndexedDB key. On startup we hydrate them back and resume.
//
// CLIENT-ONLY: imports idb-keyval (touches indexedDB) and uses window — never
// import from the server entry (entry-client is the sole importer, like
// query-persister).

const STORE_KEY = "web-ui-paused-mutations";

// Chain IndexedDB writes so rapid mutation-cache events (create → pause → resume)
// can never land their set/del out of order and leave a stale queue on disk.
let writeChain: Promise<void> = Promise.resolve();

async function persist(queryClient: QueryClient): Promise<void> {
	const { mutations } = dehydrate(queryClient, {
		// Persist ONLY paused (queued) mutations…
		shouldDehydrateMutation: (mutation) => mutation.state.isPaused,
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
		// handlers come from setMutationDefaults(key) (register those FIRST).
		hydrate(queryClient, state);
	} catch {
		// Corrupt payload: discard rather than wedge every future load.
		await del(STORE_KEY);
	}
}

/**
 * Installs the offline mutation queue on the client query client. Registers
 * mutation defaults must have run FIRST (rehydrated mutations resolve their
 * functions by key). Then, in order:
 *   1. subscribe so paused mutations are persisted to IndexedDB on every change;
 *   2. resume the queue whenever connectivity returns (`online` event);
 *   3. restore any mutations persisted by a previous document and resume them —
 *      the reload-survival flush. Resumption is FIFO (query-core guarantee).
 * Awaiting the returned promise means the startup restore+resume has been kicked.
 */
export async function installOfflineMutationQueue(queryClient: QueryClient): Promise<void> {
	queryClient.getMutationCache().subscribe(() => {
		schedulePersist(queryClient);
	});
	window.addEventListener("online", () => {
		void queryClient.resumePausedMutations();
	});
	await restore(queryClient);
	await queryClient.resumePausedMutations();
}
