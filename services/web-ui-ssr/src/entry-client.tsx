import "./styles.css";
import { Serwist as SerwistWindow } from "@serwist/window";
import { RouterClient } from "@tanstack/solid-router/ssr/client";
import { hydrate, render } from "solid-js/web";
import { type ActionHandle, beginAction, endAction } from "./observability/browser-events";
import { createQueryClient } from "./query-client";
import { createIdbQueryPersister } from "./query-persister";
import { registerMutationDefaults } from "./queue/mutation-defaults";
import { installOfflineMutationQueue } from "./queue/mutation-persister";
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
const transport = getClientTransport();
const queryClient = createQueryClient({ persister: createIdbQueryPersister().persisterFn });

// ─── Offline mutation queue (task 1w9.4) ──────────────────────────────────────
// Register per-mutation-key defaults BEFORE restoring/resuming: a paused mutation
// persisted to IndexedDB lost its functions, so on rehydrate it resolves its
// mutationFn + reconciliation handlers by key (setMutationDefaults). Then install
// the queue — subscribe to persist paused mutations, resume on the `online` event,
// and flush any mutation that survived a previous document's reload (FIFO). Client
// -only, and kept section-contained (a sibling worktree adds SW registration here).
registerMutationDefaults(queryClient, transport);
void installOfflineMutationQueue(queryClient);
// ──────────────────────────────────────────────────────────────────────────────

const router = createRouter({
	transport,
	queryClient,
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
//
// Offline-shell branch (service worker, task 1w9.2 / design §Q1): when the SW serves
// the precached minimal offline shell for a never-visited route offline, the document
// carries the `data-offline-shell` marker, an EMPTY <body>, and no dehydrated state —
// there is nothing to hydrate against, so client-render instead and let the route
// loader paint from the persisted query cache (1w9.3). One entry, one branch; no
// separate offline build.
if (document.documentElement.hasAttribute("data-offline-shell")) {
	render(() => <RouterClient router={router} />, document.body);
} else {
	hydrate(() => <RouterClient router={router} />, document.body);
}

// Register the service worker (assets + navigation shell — task 1w9.2). Prod-only
// (dev uses rsbuild HMR + a raw SSR path a SW would fight), feature-detected, and
// deferred to window `load` so it never competes with the hydration-critical path.
// Import-safe under SSR: this whole module is client-only (entry-server never imports
// it). The SW itself excludes all TodoService RPCs — see src/sw.ts.
if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		void new SerwistWindow("/sw.js", { scope: "/" }).register();
	});
}
