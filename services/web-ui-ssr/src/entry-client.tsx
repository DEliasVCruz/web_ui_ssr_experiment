import "./styles.css";
import { RouterClient } from "@tanstack/solid-router/ssr/client";
import { hydrate } from "solid-js/web";
import { createQueryClient } from "./query-client";
import { createRouter } from "./router";
import { getClientTransport } from "./transport-client";

const router = createRouter({
	transport: getClientTransport(),
	queryClient: createQueryClient(),
});

hydrate(() => <RouterClient router={router} />, document);
