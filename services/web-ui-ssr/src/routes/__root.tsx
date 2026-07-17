import type { Transport } from "@connectrpc/connect";
import type { QueryClient } from "@tanstack/solid-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet } from "@tanstack/solid-router";
import { Suspense } from "solid-js";
import { OfflineBanner } from "../components/offline-banner";
import { Toaster } from "../components/ui/toast";
import type { SsrContext } from "../router";

interface RouterContext {
	queryClient: QueryClient;
	transport: Transport;
	ssr?: SsrContext | undefined;
}

// Document assembly, given @tanstack/solid-router's RouterServer/RouterClient:
//   - RouterServer/RouterClient provide the <html><head></head><body> shell.
//   - <HeadContent> (rendered in the body per its own docs) portals the head()
//     meta/links — including the FOUC-preventing CSS <link> from ssrContext —
//     into <head>. It is LOAD-BEARING here, not redundant: under @rsbuild/plugin-solid
//     the nested MetaProvider inside RouterServer's ServerHeadContent does not hoist
//     title/meta/links, so removing this <HeadContent> empirically drops ALL head
//     tags (title/description/charset/viewport/CSS) from the SSR output. It also
//     keeps the head reactive across client navigation.
//   - The client bundle <script> tags come from the route-level `scripts` option
//     (below), which the framework's <Scripts> renders once in the body. They are
//     intentionally NOT in head()'s `scripts`, which would render them a second
//     time via RouterServer's ServerHeadContent.
export const Route = createRootRouteWithContext<RouterContext>()({
	head: ({ match }) => ({
		meta: [
			{ charset: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1.0" },
		],
		links: [
			...(match.context.ssr?.cssUrls ?? []).map((href: string) => ({
				rel: "stylesheet",
				href,
			})),
			// Preload hints for the async (code-split) chunks so the route chunk
			// and its deps (e.g. the arktype validation chunk on /todos) download
			// in parallel with the entry instead of after it executes — killing
			// the request waterfall on the hydration critical path. Classic
			// scripts, so rel=preload (not modulepreload). See SsrContext.
			...(match.context.ssr?.preloadScriptUrls ?? []).map((href: string) => ({
				rel: "preload",
				as: "script",
				href,
			})),
		],
	}),
	scripts: ({ match }) =>
		(match.context.ssr?.scriptUrls ?? []).map((src: string) => ({
			src,
			defer: true,
		})),
	component: () => (
		<>
			<HeadContent />
			{/* App-shell offline banner (1w9.4 §4.6). Empty during SSR/hydration
			    (online-assumed), like the Toaster region — never mismatches. */}
			<OfflineBanner />
			<nav>
				<Link to="/">Home</Link>
				<Link to="/todos">Todos</Link>
			</nav>
			<main>
				<Suspense>
					<Outlet />
				</Suspense>
			</main>
			{/* App-shell toast region (ol9.5). Empty during SSR/hydration; toasts are
			    only ever emitted by client interactions, so it never mismatches. */}
			<Toaster />
		</>
	),
});
