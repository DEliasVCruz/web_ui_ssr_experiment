import {
	type AsyncStorage,
	experimental_createQueryPersister,
} from "@tanstack/query-persist-client-core";
import { del, get, set } from "idb-keyval";

// Retention window for a persisted query: createQueryPersister discards (on
// restore, and via persisterGc) any entry whose data is older than this. 7 days,
// matched to the query client's gcTime so a query evicted from the in-memory
// cache and one aged out of IndexedDB expire on the same clock.
const MAX_AGE_MS = 604_800_000; // 7 days

// AsyncStorage backed by idb-keyval (IndexedDB). Serialization stays the
// persister default (JSON.stringify / JSON.parse), so IndexedDB holds plain
// strings — hence AsyncStorage<string>.
//
// CLIENT-ONLY: importing this module pulls in idb-keyval, which touches
// `indexedDB`. It must never be imported by the server entry. query-client.ts
// takes the persisterFn as a parameter (not this module), so the server can omit
// the persister entirely and keep idb-keyval out of the server bundle.
const idbStorage: AsyncStorage = {
	// idb-keyval get<T = any>; AsyncStorage (default TStorageValue = string) already
	// fixes the return contract, so no explicit type argument is needed here.
	getItem: (key) => get(key),
	setItem: (key, value) => set(key, value),
	removeItem: (key) => del(key),
};

/**
 * Builds the per-query IndexedDB persister. Wire its `.persisterFn` onto the
 * query client's `defaultOptions.queries.persister` (see query-client.ts). The
 * persisterFn lazily restores each query from IndexedDB on its first fetch, but
 * ONLY when `query.state.data === undefined` — so an SSR-dehydrated (hydrated)
 * query is never clobbered by staler persisted data.
 */
export function createIdbQueryPersister() {
	return experimental_createQueryPersister({
		storage: idbStorage,
		maxAge: MAX_AGE_MS,
	});
}
