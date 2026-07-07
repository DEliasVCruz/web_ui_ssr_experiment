import "./styles.css";
import { RouterClient } from "@tanstack/solid-router/ssr/client";
import { hydrate } from "solid-js/web";
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

const router = createRouter({
	transport: getClientTransport(),
	queryClient: createQueryClient(),
	ssrContext: { cssUrls, scriptUrls: [] },
});

// Hydrate <body>, not document: RouterServer emits the <html>/<head> shell inside a
// NoHydration boundary (static), and the hydratable app tree lives in <body>.
// Hydrating `document` misaligns the root hydration keys and silently bails, leaving
// the page rendered-but-inert (no event handlers, links do full reloads).
hydrate(() => <RouterClient router={router} />, document.body);
