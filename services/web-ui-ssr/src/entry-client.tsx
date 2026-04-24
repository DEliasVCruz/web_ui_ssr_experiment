import { hydrate as hydrateQuery } from "@tanstack/solid-query";
import { hydrate } from "solid-js/web";
import { App } from "./app";
import { createQueryClient } from "./query-client";
import { getClientTransport } from "./transport-client";

const root = document.getElementById("app");
if (root) {
	const queryClient = createQueryClient();
	const transport = getClientTransport();

	// Read dehydrated state injected by the server
	const stateEl = document.getElementById("__QUERY_STATE__");
	if (stateEl?.textContent) {
		try {
			const dehydratedState = JSON.parse(stateEl.textContent, (_key, value: unknown) =>
				typeof value === "string" && value.startsWith("__bigint__")
					? BigInt(value.slice("__bigint__".length))
					: value,
			) as Record<string, unknown>;
			hydrateQuery(queryClient, dehydratedState);
		} catch {
			// Prefetched state unavailable; queries will refetch on mount
		}
	}

	hydrate(() => <App queryClient={queryClient} transport={transport} />, root);
}
