import { PinoTransport } from "@loglayer/transport-pino";
import { LogLayer, LogLevel } from "loglayer";
import pino from "pino";
import type { WideEvent } from "./wide-event";

// The mandated stack is LogLayer (wide-event ergonomics) over
// @loglayer/transport-pino over pino, using pino's DEFAULT synchronous stdout
// destination with NO pino transports — the pino worker-thread transport path
// breaks under Bun bundling (research-validated), and a wide event is one small
// sync line per request, so a worker buys nothing.
//
// Pino is configured to strip its envelope down to a bare wide-event object:
//   * base: null      → drop the default `pid` + `hostname` bindings
//   * timestamp: false → we emit our own ISO `timestamp` field
// The one field that cannot be removed is pino's leading `level`: dropping it —
// alone, or together with the timestamp — leaves pino's fast JSON path writing
// a malformed `{,…}` line. So each line is `{"level":30,…schema fields…}`.
// `level` is a standard structured-log field and does not affect trace_id
// correlation across services.

// pino redact guards the free-form `attributes` map: the current schema carries
// no secrets or PII (trace ids, HTTP method/path/status), so these paths are a
// forward-looking defence for anything future code adds to `attributes`. Missing
// paths are a no-op in pino, so this is inert until such a key appears.
const REDACT_PATHS = [
	"attributes.authorization",
	"attributes.cookie",
	"attributes.password",
	"attributes.token",
];

/**
 * A LogLayer transport that extends the official {@link PinoTransport} but omits
 * LogLayer's always-appended (here empty) message argument, so the emitted line
 * is a byte-faithful mirror of the Java wide-event schema (no trailing
 * `"msg":""`).
 */
class WideEventPinoTransport extends PinoTransport {
	override shipToLogger(params: Parameters<PinoTransport["shipToLogger"]>[0]): unknown[] {
		const { messages, data, hasData } = params;
		const message = messages.join(" ");
		if (data !== undefined && hasData === true) {
			if (message.length > 0) {
				this.logger.info(data, message);
				return [data, message];
			}
			this.logger.info(data);
			return [data];
		}
		this.logger.info(message);
		return [message];
	}
}

/** Emits wide events as one JSON line each. */
export interface WideEventLogger {
	emit(event: WideEvent): void;
}

/**
 * Builds a {@link WideEventLogger}. Defaults to pino's synchronous stdout
 * destination (`fd 1`); a destination stream can be injected for tests to
 * capture the exact emitted bytes.
 */
export function createWideEventLogger(destination?: pino.DestinationStream): WideEventLogger {
	const options = {
		base: null,
		timestamp: false,
		redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
	} satisfies pino.LoggerOptions;
	const stream = destination ?? pino.destination({ sync: true });
	const logger = pino(options, stream);
	const log = new LogLayer({ transport: new WideEventPinoTransport({ logger }) });

	return {
		emit(event: WideEvent): void {
			// `rootData` spreads the schema fields at the JSON root (not nested under
			// a "metadata" key), and no message is passed.
			log.raw({ logLevel: LogLevel.info, rootData: event as unknown as Record<string, unknown> });
		},
	};
}
