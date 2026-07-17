import { describe, expect, test } from "bun:test";
import type { QueryPersister } from "@tanstack/solid-query";
import { createQueryClient } from "./query-client";
import { createIdbQueryPersister } from "./query-persister";

const FIVE_MIN_MS = 300_000;
const SEVEN_DAYS_MS = 604_800_000;

describe("createQueryClient", () => {
	test("server config (no persister arg) attaches NO query persister", () => {
		// The server call site (entry-server) passes no persister. IndexedDB does not
		// exist in Bun/Node and SSR must stay byte-identical, so the persister slot
		// must be undefined on the server client.
		const client = createQueryClient();
		const queries = client.getDefaultOptions().queries;
		expect(queries?.persister).toBeUndefined();
	});

	test("client config wires the supplied persister onto queries", () => {
		// The client call site (entry-client) passes createIdbQueryPersister().persisterFn.
		// A sentinel function stands in so the test asserts pure wiring, no IndexedDB.
		const persister = (() => undefined) as unknown as QueryPersister;
		const client = createQueryClient({ persister });
		expect(client.getDefaultOptions().queries?.persister).toBe(persister);
	});

	test("queries are offlineFirst with 5min staleTime / 7d gcTime", () => {
		const queries = createQueryClient().getDefaultOptions().queries;
		expect(queries?.networkMode).toBe("offlineFirst");
		expect(queries?.staleTime).toBe(FIVE_MIN_MS);
		expect(queries?.gcTime).toBe(SEVEN_DAYS_MS);
		expect(queries?.retry).toBe(false);
	});

	test("mutations pause on offline (networkMode 'online'), NOT offlineFirst", () => {
		// The hinge of the offline queue (1w9.4): offline mutations must pause so they
		// can be resumed, never fire against a dead network.
		const mutations = createQueryClient().getDefaultOptions().mutations;
		expect(mutations?.networkMode).toBe("online");
	});
});

describe("createIdbQueryPersister", () => {
	test("exposes a persisterFn function for the query client (wiring shape)", () => {
		// Building the persister does not touch IndexedDB (only getItem/setItem do),
		// so this is safe under bun:test with no `indexedDB` global.
		const persister = createIdbQueryPersister();
		expect(typeof persister.persisterFn).toBe("function");
	});
});
