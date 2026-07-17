import { QueryClient, type QueryPersister } from "@tanstack/solid-query";

// staleTime SUPERSEDES the previous global 30s (1w9.1 offline-support design).
// Now 5 minutes: SSR-dehydrated and IndexedDB-persisted list/detail data is
// treated as fresh for 5 min, so a client navigation or a persisted-cache
// restore serves it without an eager refetch — this is what keeps the offline
// read path network-free and preserves the no-double-fetch guarantee on initial
// load. gcTime is 7 days, matched to the persister's maxAge (query-persister.ts)
// so the in-memory and IndexedDB retention windows expire together.
const STALE_TIME_MS = 300_000; // 5 minutes
const GC_TIME_MS = 604_800_000; // 7 days

/**
 * Builds the query client for one render (one per request on the server, one per
 * document on the client).
 *
 * The `persister` is CLIENT-ONLY. The client entry passes
 * `createIdbQueryPersister().persisterFn`; the server entry passes nothing, so on
 * the server `persister` is `undefined` — there is no IndexedDB in Bun/Node and
 * SSR must stay byte-identical to before (queries fetch server→backend and
 * dehydrate). The environment branch therefore lives at the call sites
 * (entry-client vs entry-server), not inside this factory.
 */
export function createQueryClient(opts?: { persister?: QueryPersister }): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: STALE_TIME_MS,
				gcTime: GC_TIME_MS,
				retry: false,
				// offlineFirst: the query's first fetch attempt runs even when the
				// browser is offline, so the per-query persister (persisterFn) gets its
				// chance to restore from IndexedDB instead of the query sitting
				// 'paused'. This is what lets router loaders (ensureQueryData) resolve
				// offline from the persisted cache with no blank frame. Online it
				// behaves exactly like the default, so no CRUD behaviour changes.
				networkMode: "offlineFirst",
				// CLIENT-ONLY. The persisterFn restores each query from IndexedDB on its
				// first fetch, but ONLY when query.state.data === undefined (see the
				// createPersister source), so SSR-hydrated data always wins over staler
				// persisted data — the hydrate-then-restore ordering is safe by
				// construction. Spread so the key is OMITTED (never present-with-
				// undefined) on the server: under exactOptionalPropertyTypes the
				// `persister?` slot accepts a value or absence, not an explicit
				// undefined, and an absent persister is what disables persistence.
				...(opts?.persister ? { persister: opts.persister } : {}),
			},
			mutations: {
				// Mutations PAUSE when offline (networkMode 'online' — the default,
				// stated explicitly because it is the hinge of the offline queue). Their
				// onMutate still runs (the optimistic cache write applies immediately),
				// but the mutationFn is deferred until reconnect, when 1w9.4 will resume
				// them via resumePausedMutations(). Deliberately NOT 'offlineFirst':
				// queued writes must never fire against a dead network.
				networkMode: "online",
			},
		},
	});
}
