import { createConnectTransport as createNodeTransport } from "@connectrpc/connect-node";
import { createConnectTransport } from "@connectrpc/connect-web";

const BUSINESS_LOGIC_URL = process.env.BUSINESS_LOGIC_URL ?? "http://localhost:3001";

export function createServerTransport() {
	return createNodeTransport({
		baseUrl: BUSINESS_LOGIC_URL,
		httpVersion: "1.1",
	});
}

/**
 * Browser transport — points directly at the business-logic server,
 * bypassing the rendering server for all post-hydration RPC traffic.
 *
 * `PUBLIC_BUSINESS_LOGIC_URL` is replaced at build time by Rsbuild's
 * `source.define` so the value is baked into the client bundle.
 */
declare const PUBLIC_BUSINESS_LOGIC_URL: string;

export function createClientTransport() {
	return createConnectTransport({
		baseUrl: PUBLIC_BUSINESS_LOGIC_URL,
	});
}
