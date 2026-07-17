import "./styles.css";
import { RouterClient } from "@tanstack/solid-router/ssr/client";
import { hydrate } from "solid-js/web";
import { type ActionHandle, beginAction, endAction } from "./observability/browser-events";
import { createQueryClient } from "./query-client";
import { createIdbQueryPersister } from "./query-persister";
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

// The IndexedDB per-query persister is attached CLIENT-ONLY (entry-server never
// imports query-persister, so the server bundle carries no idb-keyval and SSR is
// unchanged). The persisterFn restores each query from IndexedDB on its first
// fetch — after SSR hydration, and only when the query has no data yet — so the
// dehydrated SSR payload is never clobbered by staler persisted data.
const router = createRouter({
	transport: getClientTransport(),
	queryClient: createQueryClient({ persister: createIdbQueryPersister().persisterFn }),
	ssrContext: { cssUrls, scriptUrls: [], preloadScriptUrls },
});

// Route navigations are user actions (task iq2.4): open an action scope when a
// navigation begins and close it when it settles, so the loader RPCs a client
// navigation fires (browser→Java, bypassing SSR) share one trace_id and emit a
// browser wide event. Client-only (this module never runs under SSR).
//
// Close paths (review F4) — this router version's RouterEvents has NO error
// event, so the scope is closed on every terminal signal it does have:
//   * supersede: a new navigation closes the previous unresolved scope first;
//   * "onResolved": the Solid Transitioner emits it purely off the router's
//     pending→idle flip (isAnyPending true→false), NOT off load success — so it
//     also fires for a navigation whose loader ERRORED (the error boundary
//     renders and pending clears), closing the scope on the error path too;
//   * "onRendered": belt-and-braces backstop on the same transition family.
// endAction is idempotent (an ended scope is a no-op to close again), so the
// redundant paths can never double-emit.
let navHandle: ActionHandle | undefined;
const closeNavAction = () => {
	if (navHandle !== undefined) {
		endAction(navHandle);
		navHandle = undefined;
	}
};
router.subscribe("onBeforeNavigate", () => {
	closeNavAction();
	navHandle = beginAction("navigate");
});
router.subscribe("onResolved", closeNavAction);
router.subscribe("onRendered", closeNavAction);

// Hydrate <body>, not document: RouterServer emits the <html>/<head> shell inside a
// NoHydration boundary (static), and the hydratable app tree lives in <body>.
// Hydrating `document` misaligns the root hydration keys and silently bails, leaving
// the page rendered-but-inert (no event handlers, links do full reloads).
hydrate(() => <RouterClient router={router} />, document.body);
