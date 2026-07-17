# Framework & out-of-request logging (business-logic-java)

The service emits **two JSON-line streams to stdout**, sharing a naming
convention but **not** a schema:

1. **Wide events** — one structured line per HTTP request, at request
   completion. Schema and rationale: [wide-events.md](./wide-events.md).
2. **Framework / out-of-request logs** — everything else the JVM logs: Helidon
   startup, Flyway migrations, HikariCP pool lifecycle, avaje-config/-inject
   wiring, the app's own startup line, shutdown, and any error thrown outside a
   request (e.g. a failed DB connection at boot). This document covers stream 2.

Both are line-delimited JSON on the same stdout, so a collector can parse every
line as JSON and route on shape.

## How it works (Helidon built-ins — no SLF4J/Logback, no jul-to-slf4j bridge)

Framework logs use Helidon's own `java.util.logging` (JUL) facilities. There is
deliberately **no** Logback and **no** jul-to-slf4j bridge: Helidon logs
natively through JUL, so routing JUL *out* to SLF4J+Logback would add a bridge
(~60x cost on disabled log statements) only to re-unify what JUL already
unifies. JUL stays the single sink.

Wiring (all in `services/business-logic-java`):

- **`logging.properties`** (on the classpath) sets the root handler to
  `io.helidon.logging.jul.HelidonConsoleHandler` (writes to **System.out**, not
  stderr — so it shares the wide-event stream) and its formatter to
  `io.helidon.logging.jul.HelidonJsonFormatter`.
- **`helidon-logging-jul`** (explicit runtime dependency; in the 4.4.1 BOM)
  provides that handler + formatter and the JUL `LoggingProvider` SPI that
  actually reads the classpath `logging.properties`. Plain JUL does **not**
  auto-read a classpath `logging.properties`; Helidon's provider does.
- **`Main.start()`** calls `io.helidon.logging.common.LogConfig.configureRuntime()`
  as its first statement — **before** the DI graph is built — so the Flyway
  migrations (which run in the `TodoDb` constructor during that build) and the
  HikariCP pool startup are already logging as JSON. Helidon also invokes this
  itself later, during `WebServer.start()`, but that is too late for the boot
  migrations; the call is idempotent, so doing it early is safe.
- **`slf4j-jdk14`** (runtime) routes SLF4J → JUL. HikariCP (and any pure-SLF4J
  dependency) logs through SLF4J; with no SLF4J binding on the classpath those
  records hit the NOP logger and are **silently lost** — verified: before this
  binding, HikariCP's pool-start and connection-failure logs never appeared, and
  slf4j-api printed `No SLF4J providers were found` at boot. `slf4j-jdk14` funnels
  them into the same JSON stream and silences that warning. This is the
  **opposite** direction of the rejected jul-to-slf4j bridge (SLF4J → JUL, not
  JUL → SLF4J), so JUL remains the single sink. Flyway is unaffected — it already
  logs through JUL directly.

## JSON field set

Configured via `io.helidon.logging.jul.HelidonJsonFormatter.fields`
(SimpleFormatter-style conversions; comma separates fields, the first colon of
each field separates `jsonName:format`). Blank values are **omitted**, so
`exception` appears only on records carrying a `Throwable`.

| JSON key    | Source                    | Notes |
|-------------|---------------------------|-------|
| `timestamp` | record instant            | ISO-8601 date-time **with numeric offset** (e.g. `2026-07-17T08:02:58.112-0500`). See timestamp note below. |
| `level`     | JUL level name            | `INFO`, `WARNING`, `SEVERE`, … |
| `message`   | formatted message         | |
| `logger`    | JUL logger name           | The emitting class, e.g. `io.helidon.webserver.LoomServer`. |
| `exception` | printed stack trace        | Present only when the record carries a `Throwable`. |

**Alignment with the wide-event schema** is by *key name where the concepts
overlap*, not a shared schema:

- `timestamp` is the shared key. The wide event uses `java.time.Instant`
  (always real-UTC, `Z`-suffixed). The framework formatter builds its value from
  the JVM's default zone, so it renders the value **with the actual numeric
  offset** (`%1$tz`) rather than a hard-coded `Z` — a literal `Z` would *lie*
  whenever the JVM is not on UTC. Both are valid ISO-8601 and resolve to the same
  absolute instant; a consumer normalizing to instant handles either.
- `logger` (emitting class) is the framework-log analogue of the wide event's
  `component`, but is deliberately **not** named `component`: the wide event's
  `component` is the *service identity* (`business-logic-java`), whereas `logger`
  is a class name. Different values → different key, to avoid false alignment.
- `level`, `message`, `exception` have no wide-event counterpart (the wide event
  is fully structured); `exception` is a flat stack trace, distinct from the wide
  event's nested `error` object.

The **`thread` field is intentionally dropped.** Request work runs on *unnamed*
virtual threads, so a thread value would be blank/empty noise; do not rely on a
thread field being present in this stream.

## Coverage: which stream catches what

- **Completed HTTP requests** (success, Connect error, or an exception the
  outermost filter saw) → **wide event**, always exactly one line.
- **Pre-routing rejections** (a malformed HTTP prologue / bad request line that
  Helidon rejects *before* the routing + filter chain runs) → **no wide event**:
  `WideEventFilter` never executes for them. If they surface anywhere, it is in
  this framework-log stream (Helidon's webserver logger). Do not expect a wide
  event for every socket that hits the port.
- **Boot / lifecycle / out-of-request errors** (Flyway, HikariCP, Helidon
  startup + shutdown, a DB-unreachable failure at boot) → **framework logs**.

## Known non-JSON lines at boot (documented exceptions)

After this change, essentially everything the application logs on stdout/stderr
is JSON. The remaining non-JSON output is **JVM-emitted, not application
logging**, and cannot be routed through the formatter:

- The JDK `sun.misc.Unsafe::arrayBaseOffset` *terminally deprecated method*
  warnings (4 lines to stderr), emitted by the JVM itself because
  `com.google.protobuf.UnsafeUtil` calls the deprecated API. These come from the
  runtime, not from any logger, so no logging config can format them. They are a
  protobuf-on-modern-JDK artifact, harmless, and out of scope here.

## Tests

Unit tests that boot the server directly through `WebServer.builder()` (not
`Main.start()`) keep the JVM-default JUL config and are unaffected. The
integration tests (`*IT`) go through `Main.start()`, so they exercise the real
JSON logging path. Helidon's provider prefers a `logging-test.properties` over
`logging.properties` if one is present on the classpath; none is needed here.
