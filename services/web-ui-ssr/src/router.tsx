import type { Transport } from "@connectrpc/connect";
import type { QueryClient } from "@tanstack/solid-query";
import { createRouter as createSolidRouter } from "@tanstack/solid-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/solid-router-ssr-query";
import { routeTree } from "./routeTree.gen";

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
	// transport + queryClient live on the router context so they reach route
	// loaders AND components (via Route.useRouteContext). A Solid context Provider
	// (Wrap/InnerWrap) would NOT survive the code-split/streaming boundary on the
	// server, so components must read them from the router context, not Solid ctx.
	const router = createSolidRouter({
		routeTree,
		defaultPreload: "intent",
		scrollRestoration: true,
		context: {
			queryClient: opts.queryClient,
			transport: opts.transport,
			ssr: opts.ssrContext,
		},
	});
	setupRouterSsrQueryIntegration({ router, queryClient: opts.queryClient });
	return router;
}

declare module "@tanstack/solid-router" {
	interface Register {
		router: ReturnType<typeof createRouter>;
	}
}
