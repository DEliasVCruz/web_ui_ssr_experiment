import { createConnectTransport as createNodeTransport } from "@connectrpc/connect-node";

const BUSINESS_LOGIC_URL = process.env.BUSINESS_LOGIC_URL ?? "http://localhost:3001";

export function createServerTransport() {
	return createNodeTransport({
		baseUrl: BUSINESS_LOGIC_URL,
		httpVersion: "1.1",
	});
}
