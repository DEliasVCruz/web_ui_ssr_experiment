import { addStaticKeyToTransport } from "@connectrpc/connect-query-core";
import { createConnectTransport } from "@connectrpc/connect-web";

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
	}),
	"app",
);

export function getClientTransport() {
	return clientTransport;
}
