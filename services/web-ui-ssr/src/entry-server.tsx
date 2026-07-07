import {
	createRequestHandler,
	RouterServer,
	renderRouterToStream,
} from "@tanstack/solid-router/ssr/server";
import { createQueryClient } from "./query-client";
import { createRouter, type SsrContext } from "./router";
import { createServerTransport } from "./transport";

export function render(request: Request, ssrContext: SsrContext): Promise<Response> {
	const handler = createRequestHandler({
		request,
		createRouter: () =>
			createRouter({
				transport: createServerTransport(),
				queryClient: createQueryClient(),
				ssrContext,
			}),
	});

	return handler(({ request: req, responseHeaders, router }) =>
		renderRouterToStream({
			request: req,
			responseHeaders,
			router,
			children: () => <RouterServer router={router} />,
		}),
	);
}
