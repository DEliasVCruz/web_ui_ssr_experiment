import { addStaticKeyToTransport } from "@connectrpc/connect-query-core";
import { createConnectTransport } from "@connectrpc/connect-web";

// Destructure with a default rather than `process.env.BUSINESS_LOGIC_URL`:
// noPropertyAccessFromIndexSignature (TS4111) forbids dot access on the env index
// signature, while biome's useLiteralKeys forbids `process.env["…"]`. Destructuring
// with a default is exempt from both and preserves the `?? default` semantics
// (env values are never null, so undefined-only defaulting is equivalent).
const { BUSINESS_LOGIC_URL = "http://localhost:3001" } = process.env;

/**
 * SSR transport — the same fetch-based connect-web transport the browser uses,
 * pointed at the business-logic server. Bun (and Node's global fetch) provide
 * the `fetch` connect-web needs, so there is no reason to keep the heavier
 * `@connectrpc/connect-node` transport just for SSR: one transport implementation
 * now serves both environments.
 *
 * `useHttpGet: true` lets idempotent (idempotency_level = NO_SIDE_EFFECTS) RPCs —
 * ListTodos and GetTodo — go over HTTP GET; mutations stay POST. `useBinaryFormat`
 * keeps every call on binary protobuf.
 */
export function createServerTransport() {
	return addStaticKeyToTransport(
		createConnectTransport({
			baseUrl: BUSINESS_LOGIC_URL,
			useBinaryFormat: true,
			useHttpGet: true,
		}),
		"app",
	);
}
