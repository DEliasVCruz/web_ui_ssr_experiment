import { addStaticKeyToTransport } from "@connectrpc/connect-query-core";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createTraceParentInterceptor } from "./observability/browser-events";

/**
 * Browser transport — points directly at the business-logic server,
 * bypassing the rendering server for all post-hydration RPC traffic.
 *
 * `PUBLIC_BUSINESS_LOGIC_URL` is replaced at build time by Rsbuild's
 * `source.define` so the value is baked into the client bundle.
 */
declare const PUBLIC_BUSINESS_LOGIC_URL: string;

const clientTransport = addStaticKeyToTransport(
	createConnectTransport({
		baseUrl: PUBLIC_BUSINESS_LOGIC_URL,
		useBinaryFormat: true,
		// Idempotent RPCs (idempotency_level = NO_SIDE_EFFECTS: ListTodos, GetTodo)
		// go over HTTP GET; mutations stay POST. Payload stays binary protobuf.
		useHttpGet: true,
		// W3C trace propagation for client RPCs (task iq2.4). These calls go
		// browser→Java directly, bypassing the SSR middleware, so this interceptor
		// is their ONLY trace source: it stamps a child `traceparent` (the active
		// user action's trace_id + a fresh span per call) so the backend wide event
		// correlates with the browser action. Backend CORS must allow the
		// `traceparent` request header — see ConnectCors.ALLOWED_HEADERS.
		interceptors: [createTraceParentInterceptor()],
	}),
	"app",
);

export function getClientTransport() {
	return clientTransport;
}
