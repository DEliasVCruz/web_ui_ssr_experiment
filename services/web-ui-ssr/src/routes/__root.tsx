import type { Transport } from "@connectrpc/connect";
import type { QueryClient } from "@tanstack/solid-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet } from "@tanstack/solid-router";
import { Suspense } from "solid-js";
import type { SsrContext } from "../router";

interface RouterContext {
	queryClient: QueryClient;
	transport: Transport;
	ssr?: SsrContext;
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
		links: (match.context.ssr?.cssUrls ?? []).map((href: string) => ({
			rel: "stylesheet",
			href,
		})),
	}),
	scripts: ({ match }) =>
		(match.context.ssr?.scriptUrls ?? []).map((src: string) => ({
			src,
			defer: true,
		})),
	component: () => (
		<>
			<HeadContent />
			<nav>
				<Link to="/">Home</Link>
				<Link to="/todos">Todos</Link>
			</nav>
			<main>
				<Suspense>
					<Outlet />
				</Suspense>
			</main>
		</>
	),
});
