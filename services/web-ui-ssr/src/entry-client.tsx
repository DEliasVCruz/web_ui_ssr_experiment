import { hydrate as hydrateQuery } from "@tanstack/solid-query";
import { hydrate } from "solid-js/web";
import { App } from "./app";
import { createQueryClient } from "./query-client";

const root = document.getElementById("app");
if (root) {
	const queryClient = createQueryClient();

	// Read dehydrated state injected by the server
	const stateEl = document.getElementById("__QUERY_STATE__");
	if (stateEl?.textContent) {
		try {
			const dehydratedState = JSON.parse(stateEl.textContent);
			hydrateQuery(queryClient, dehydratedState);
		} catch {
			// Prefetched state unavailable; queries will refetch on mount
		}
	}

	hydrate(() => <App queryClient={queryClient} />, root);
}
