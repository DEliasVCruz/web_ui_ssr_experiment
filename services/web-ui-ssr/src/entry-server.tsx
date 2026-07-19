import {
	createRequestHandler,
	RouterServer,
	renderRouterToStream,
} from "@tanstack/solid-router/ssr/server";
import { createQueryClient } from "./query-client";
import { createRouter, type SsrContext } from "./router";
import { createServerTransport } from "./transport";

// The streamed SSR document is emitted with TWO `<!DOCTYPE html>` declarations
// back-to-back (`<!DOCTYPE html><!DOCTYPE html><html>…`). This is an upstream
// double-emit in @tanstack/solid-router: `renderRouterToStream` prepends its own
// `Solid.ssr("<!DOCTYPE html>")` to the render tree, AND the `RouterServer`
// component we hand it as `children` ALSO opens with `ssr("<!DOCTYPE html>")`
// (see dist/esm/ssr/renderRouterToStream.js + RouterServer.js). Composing the two
// — the documented pairing — therefore doubles the prefix. Browsers ignore the
// second doctype, but the output is malformed. We can't stop either library
// function from emitting its copy without patching node_modules (which the FOD
// build wouldn't carry), so we strip the redundant one at this seam — the exact
// point where the two are composed — leaving the rest of the stream byte-for-byte
// untouched (hydration, the SW navigation cache, and the raw-HTML specs all
// depend on that). The offline shell (src/index.ts renderOfflineShell) emits a
// single doctype of its own and is not routed through here, so it is unaffected.
const DOCTYPE_BYTES = new TextEncoder().encode("<!DOCTYPE html>");

/** True iff `buf` contains `prefix` starting at `offset`. */
function hasPrefixAt(buf: Uint8Array, prefix: Uint8Array, offset: number): boolean {
	if (buf.length < offset + prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (buf[offset + i] !== prefix[i]) return false;
	}
	return true;
}

/**
 * Drops the FIRST of two adjacent leading `<!DOCTYPE html>` declarations, if
 * present, and passes the remainder of the stream through unchanged. Only the
 * leading bytes are inspected: we buffer just enough of the stream (two doctypes'
 * worth) to make the decision, emit the adjusted head chunk, then forward every
 * later chunk verbatim so streaming is preserved and no byte after the head shifts.
 * If the doubled prefix is ever absent (e.g. an upstream fix), the stream is
 * emitted untouched.
 */
function stripDuplicateLeadingDoctype(
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	const minBytesToDecide = DOCTYPE_BYTES.length * 2;
	// Head bytes accumulated until the decision is made; null once decided.
	let pending: Uint8Array | null = new Uint8Array(0);

	const decide = (buf: Uint8Array): Uint8Array =>
		hasPrefixAt(buf, DOCTYPE_BYTES, 0) && hasPrefixAt(buf, DOCTYPE_BYTES, DOCTYPE_BYTES.length)
			? buf.subarray(DOCTYPE_BYTES.length) // drop exactly one leading doctype
			: buf;

	const transform = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (pending === null) {
				controller.enqueue(chunk);
				return;
			}
			const merged = new Uint8Array(pending.length + chunk.length);
			merged.set(pending);
			merged.set(chunk, pending.length);
			pending = merged;
			if (pending.length < minBytesToDecide) return; // need more bytes to decide
			controller.enqueue(decide(pending));
			pending = null;
		},
		flush(controller) {
			if (pending !== null && pending.length > 0) controller.enqueue(decide(pending));
			pending = null;
		},
	});

	return body.pipeThrough(transform);
}

export async function render(request: Request, ssrContext: SsrContext): Promise<Response> {
	const handler = createRequestHandler({
		request,
		createRouter: () =>
			createRouter({
				transport: createServerTransport(),
				queryClient: createQueryClient(),
				ssrContext,
			}),
	});

	const response = await handler(({ request: req, responseHeaders, router }) =>
		renderRouterToStream({
			request: req,
			responseHeaders,
			router,
			children: () => <RouterServer router={router} />,
		}),
	);

	if (!response.body) return response;
	return new Response(stripDuplicateLeadingDoctype(response.body), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
