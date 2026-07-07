import type { Transport } from "@connectrpc/connect";
import type { QueryClient } from "@tanstack/solid-query";
import { createRouter as createSolidRouter } from "@tanstack/solid-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/solid-router-ssr-query";
import { routeTree } from "./routeTree.gen";
import { TransportProvider } from "./transport-context";

export interface SsrContext {
	cssUrls: string[];
	// Multiple initial JS chunks (vendor-solid, vendor-router, entry) must all be
	// referenced for hydration because splitChunks emits them as separate initial
	// chunks — the rspack runtime does not auto-load sibling initial chunks.
	scriptUrls: string[];
}

export function createRouter(opts: {
	transport: Transport;
	queryClient: QueryClient;
	ssrContext?: SsrContext;
}) {
	const router = createSolidRouter({
		routeTree,
		defaultPreload: "intent",
		scrollRestoration: true,
		context: {
			queryClient: opts.queryClient,
			transport: opts.transport,
			ssr: opts.ssrContext,
		},
		// biome-ignore lint/style/useNamingConvention: "Wrap" is a TanStack Router option key and must match its API
		Wrap: ({ children }) => (
			<TransportProvider value={opts.transport}>{children}</TransportProvider>
		),
	});
	setupRouterSsrQueryIntegration({ router, queryClient: opts.queryClient });
	return router;
}

declare module "@tanstack/solid-router" {
	interface Register {
		router: ReturnType<typeof createRouter>;
	}
}
