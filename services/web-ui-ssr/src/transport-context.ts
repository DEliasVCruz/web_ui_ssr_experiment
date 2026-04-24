import type { Transport } from "@connectrpc/connect";
import { createContext, useContext } from "solid-js";

const TransportContext = createContext<Transport>();

export const TransportProvider = TransportContext.Provider;

export function useTransport(): Transport {
	const transport = useContext(TransportContext);
	if (!transport) throw new Error("TransportProvider missing — wrap App in TransportProvider");
	return transport;
}
