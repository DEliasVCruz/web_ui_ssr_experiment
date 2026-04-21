import { QueryClient } from "@tanstack/solid-query";

const STALE_TIME = 30_000;

export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: STALE_TIME,
				retry: false,
			},
		},
	});
}
