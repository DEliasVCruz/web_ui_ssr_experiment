import { createConnectTransport as createNodeTransport } from "@connectrpc/connect-node";
import { createConnectTransport } from "@connectrpc/connect-web";

const BUSINESS_LOGIC_URL = process.env.BUSINESS_LOGIC_URL ?? "http://localhost:3001";

export function createServerTransport() {
	return createNodeTransport({
		baseUrl: BUSINESS_LOGIC_URL,
		httpVersion: "1.1",
	});
}

export function createClientTransport() {
	return createConnectTransport({
		baseUrl: "/api",
	});
}
