import type { Transport } from "@connectrpc/connect";
import type { QueryClient } from "@tanstack/solid-query";
import { createRouter as createSolidRouter } from "@tanstack/solid-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/solid-router-ssr-query";
import { routeTree } from "./routeTree.gen";
import { viewTransitionsEnabled } from "./view-transition";

export interface SsrContext {
	cssUrls: string[];
	// Multiple initial JS chunks (vendor-solid, vendor-router, entry) must all be
	// referenced for hydration because splitChunks emits them as separate initial
	// chunks — the rspack runtime does not auto-load sibling initial chunks.
	scriptUrls: string[];
	// Async (code-split) chunks to warm via <link rel="preload" as="script">.
	// Without these hints the route chunk and its deps (e.g. the arktype
	// validation chunk on /todos) are only discovered after the entry executes,
	// putting a request waterfall on the hydration critical path. Classic
	// scripts (not ES modules), hence preload rather than modulepreload.
	preloadScriptUrls: string[];
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
		// Cross-fade route navigations via the View Transitions API (the router's
		// sanctioned option). `viewTransitionsEnabled()` returns false during SSR
		// (no `document`), in engines without the API, and under
		// `prefers-reduced-motion: reduce` — so the router simply never calls
		// `document.startViewTransition` in those cases (zero behaviour change).
		defaultViewTransition: viewTransitionsEnabled(),
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
