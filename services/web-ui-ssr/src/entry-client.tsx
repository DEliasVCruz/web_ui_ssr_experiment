import "./styles.css";
import { RouterClient } from "@tanstack/solid-router/ssr/client";
import { hydrate } from "solid-js/web";
import { type ActionHandle, beginAction, endAction } from "./observability/browser-events";
import { createQueryClient } from "./query-client";
import { createRouter } from "./router";
import { getClientTransport } from "./transport-client";

// The SSR document already carries the hashed CSS <link>(s) in <head>. Feed their
// hrefs back into the client router so the root route's head() re-declares them and
// HeadContent keeps them. Without this, the client-side ssr context is empty, so
// HeadContent reconciles the <head> to zero stylesheets and strips the CSS after
// hydration — unstyling the page.
const cssUrls = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
	.map((link) => link.getAttribute("href"))
	.filter((href): href is string => href !== null);

// Same recovery for the async-chunk preload hints (rel=preload as=script) the
// server injected — otherwise HeadContent would reconcile them away. Harmless
// resource-wise (already fetched) but keeps server/client head output identical.
const preloadScriptUrls = Array.from(
	document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="script"]'),
)
	.map((link) => link.getAttribute("href"))
	.filter((href): href is string => href !== null);

const router = createRouter({
	transport: getClientTransport(),
	queryClient: createQueryClient(),
	ssrContext: { cssUrls, scriptUrls: [], preloadScriptUrls },
});

// Route navigations are user actions (task iq2.4): open an action scope when a
// navigation begins and close it when it resolves, so the loader RPCs a client
// navigation fires (browser→Java, bypassing SSR) share one trace_id and emit a
// browser wide event. Client-only (this module never runs under SSR). A new
// navigation that supersedes an unresolved one closes the earlier scope first,
// so every opened scope is always paired with an emit.
let navHandle: ActionHandle | undefined;
router.subscribe("onBeforeNavigate", () => {
	if (navHandle !== undefined) {
		endAction(navHandle);
	}
	navHandle = beginAction("navigate");
});
router.subscribe("onResolved", () => {
	if (navHandle !== undefined) {
		endAction(navHandle);
		navHandle = undefined;
	}
});

// Hydrate <body>, not document: RouterServer emits the <html>/<head> shell inside a
// NoHydration boundary (static), and the hydratable app tree lives in <body>.
// Hydrating `document` misaligns the root hydration keys and silently bails, leaving
// the page rendered-but-inert (no event handlers, links do full reloads).
hydrate(() => <RouterClient router={router} />, document.body);
