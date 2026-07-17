# Wide-event request logging

Each service emits **one structured JSON line per HTTP request** to stdout at
request completion — the *wide-event* pattern: instead of many thin log lines,
a single rich event carries everything known about the request (trace context,
timing, HTTP + RPC outcome, and any error). This is the shared contract between
the Java service (task iq2.1, the schema's source of truth) and the TypeScript
service (task iq2.3, which mirrors it).

The Java implementation lives in the Connect adapter
(`packages/java/connect-unary-adapter`, package `com.webuipoc.connect`):

- `WideEvent` / `WideEventError` — the schema, serialized reflection-free by
  **avaje-jsonb** (`@Json` models; the generator emits the adapters at build
  time). jsonb is used **only** for this log line — an ArchUnit rule confines it
  so the Connect wire codec keeps using `JsonFormat` and the hand-rolled error
  envelope.
- `WideEventFilter` — a Helidon filter (installed outermost by
  `WideEventFeature`, above the routing/CORS filters) that builds the event,
  registers it in the request `Context`, and emits it in a `finally` so it fires
  on success, Connect error, and thrown-exception paths alike.
- `WideEvents` — the thin enrichment seam the `ConnectUnaryHandler` calls to add
  `rpc_method` and `connect_code` where that information is available.
- `TraceParent` / `TraceContext` — the hand-rolled W3C trace-context handling
  (no OpenTelemetry dependency; see "Trace context" below).

## Coverage: what a wide event does and does NOT capture

A wide event is emitted by `WideEventFilter`, which runs only once a request has
made it into the Helidon routing + filter chain. Consequently:

- **Pre-routing rejections are not captured.** A malformed HTTP prologue / bad
  request line that Helidon rejects *before* the filter chain runs produces **no
  wide event**. Those surface (if anywhere) in the **framework log** stream, not
  here — see [logging.md](./logging.md). Do not assume one wide event per socket
  that touches the port.
- **Out-of-request / boot failures are not captured** either (Flyway, HikariCP,
  startup, shutdown); they are framework logs.

The framework-log stream ([logging.md](./logging.md)) is a **separate** JSON-line
stream on the same stdout. It shares this stream's naming convention where the
concepts overlap (notably the `timestamp` key) but is **not** the same schema.

## Field schema

Serialized with snake_case keys (avaje-jsonb `LowerUnderscore` naming) and
`serializeNulls(true)`, so every nullable key is **always present** (explicit
`null`) — a stable shape for consumers.

| JSON key          | Type              | Nullable | Description |
|-------------------|-------------------|----------|-------------|
| `trace_id`        | string (32 hex)   | no       | W3C trace id. Adopted from an inbound `traceparent`, else generated. |
| `span_id`         | string (16 hex)   | no       | This hop's span id — always freshly generated. |
| `parent_span_id`  | string (16 hex)   | **yes**  | The caller's span id from a valid inbound `traceparent`; `null` when this request starts the trace. |
| `timestamp`       | string (ISO-8601) | no       | Instant the event was emitted (request completion), e.g. `2026-07-17T00:00:00.123Z`. |
| `duration_ms`     | number (long)     | no       | Whole-request wall time, measured from filter entry. |
| `http_method`     | string            | no       | e.g. `GET`, `POST`. |
| `path`            | string            | no       | Request path, e.g. `/todo.v1.TodoService/GetTodo`. |
| `status`          | number (int)      | no       | Final HTTP status. |
| `connect_code`    | string            | **yes**  | Connect wire error code (e.g. `not_found`, `invalid_argument`); `null` on success and on non-RPC requests. Also `null` on the bare HTTP 415 paths (unsupported content-type / `encoding` param): those responses carry no Connect error envelope, so an RPC-path request can have `status: 415` with `connect_code: null`. |
| `rpc_method`      | string            | **yes**  | Fully-qualified RPC method (e.g. `todo.v1.TodoService/GetTodo`); `null` for non-RPC requests (e.g. `/health`) and unknown routes. |
| `component`       | string            | no       | Emitting service, e.g. `business-logic-java`. Injected by the composition root (the adapter is service-agnostic). |
| `error`           | object            | **yes**  | Populated only when the request failed with an exception the filter saw (ordinary Connect errors use `connect_code` + `status`). See below. |
| `attributes`      | object (string→string) | no  | Extensible free-form attributes; `{}` by default. |

`error` object (projected manually — jsonb has no `Throwable` adapter):

| JSON key   | Type   | Nullable | Description |
|------------|--------|----------|-------------|
| `type`     | string | no       | Exception class FQN, e.g. `java.lang.IllegalStateException`. |
| `message`  | string | no       | Exception message (or the simple class name when it has none). |
| `stack`    | string | **yes**  | Full printed stack trace. |

### Example (success)

```json
{"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","parent_span_id":null,"timestamp":"2026-07-17T00:00:00.123Z","duration_ms":7,"http_method":"POST","path":"/todo.v1.TodoService/GetTodo","status":200,"connect_code":null,"rpc_method":"todo.v1.TodoService/GetTodo","component":"business-logic-java","error":null,"attributes":{}}
```

### Example (Connect error)

```json
{"trace_id":"...","span_id":"...","parent_span_id":null,"timestamp":"...","duration_ms":3,"http_method":"POST","path":"/todo.v1.TodoService/GetTodo","status":404,"connect_code":"not_found","rpc_method":"todo.v1.TodoService/GetTodo","component":"business-logic-java","error":null,"attributes":{}}
```

## Trace context

W3C Trace Context (`traceparent` header), parsed by a hand-rolled fixed-width
parser — **no OpenTelemetry dependency** (the deployment is agent-free by
design; the upgrade path is to add an OTel SDK/exporter later and feed it the
same ids). Version `00` format is a fixed 55 ASCII chars:

```
00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
version  trace-id (32 hex)            parent-id (16)   flags
```

Resolution rules:

- **Valid inbound header** → adopt its `trace-id`, record its `parent-id` as
  `parent_span_id`, and mint a fresh `span_id` for this hop.
- **Absent or invalid header** → start a new trace: generate `trace_id` +
  `span_id` (`SecureRandom`, lowercase hex), `parent_span_id` = `null`.

A header is rejected (treated as absent) when it is not exactly 55 chars, has
wrong delimiters, is not version `00`, contains non-lowercase-hex digits
(the spec mandates lowercase), or carries an all-zero `trace-id` or `parent-id`
(forbidden by the spec).

## TypeScript mirror (iq2.3)

The TS service must emit the identical key set, types, snake_case naming, and
nullability so the two services' logs are queryable as one stream. Emit
`component: "business-logic"` (or the TS service's name) and reuse the same
`traceparent` resolution semantics.

Implemented in `services/web-ui-ssr/src/observability/` (task iq2.3), wired at
the server's fetch boundary in `src/index.ts` (both the prod `Bun.serve` path
and the dev node-http path):

- **Stack**: LogLayer (`loglayer`) over `@loglayer/transport-pino` over `pino`,
  using pino's default **synchronous stdout** destination — no pino transports
  (the worker-thread transport path breaks under Bun bundling). A thin
  `PinoTransport` subclass omits LogLayer's empty message so each line is a
  bare schema object. One divergence from the Java lines: pino's mandatory
  leading `"level":30` field (removing `level` — on its own, or together with
  `time` — trips a pino fast-path bug that emits malformed JSON). It does not
  affect correlation.
- **Emission point**: the event is emitted when the response body reaches a
  **terminal outcome**, not when the handler returns, so `duration_ms` covers
  the whole streamed render; response bytes are untouched. A request whose
  handler throws (before any bytes leave) emits with `status: 500` and the
  projected `error`. A **null-body** response (e.g. `204`) emits synchronously.
  A **streamed** body is driven by a **manual reader pump** (task iq2.5) that
  emits on all three of the stream's terminal transitions — see
  `attributes.stream_outcome` below.
- **`stream_outcome`** (task iq2.5): for a streamed body, the pump records how
  the stream ended in `attributes.stream_outcome`. This CLOSES the two silent
  paths the earlier identity-`TransformStream` design left open (a
  `TransformStream`'s `flush` fires only on normal close, and Bun — pinned
  1.3.10, re-verified 1.3.11 — does not invoke a transformer's `cancel()` on a
  source error or reader cancel):
  - `"completed"` — the source stream closed normally: the full render flushed.
    `error` is `null`; `status` is the sent status. (A present-but-empty body
    also flows through the pump and reports `"completed"`.)
  - `"errored"` — the source stream **errored mid-body**, after the shell (and
    thus `status` + headers) had already flushed. The event records the projected
    `error` **and the already-sent `status`** — an errored stream cannot
    retroactively rewrite a status the client already received, so (unlike a
    handler that throws before any byte leaves, which is synthesized as `500`) an
    HTTP `200` shell that then errors mid-stream is recorded as `status: 200`
    with a populated `error`. The error is also surfaced downstream (the pump
    errors its controller), so the client sees a truncated/aborted body.
  - `"cancelled"` — the **downstream consumer cancelled** the body (client
    disconnected mid-stream). Not a server fault, so `error` stays `null`; the
    truncation is marked solely by this outcome. `status` is the sent status.
    The cancel is propagated upstream to release the source.

  Exactly-once holds by two independent mechanisms: the ReadableStream
  controller enforces a single terminal transition (each of close/error/cancel
  fires exactly one pump callback, and none fires after another), and an
  `emitted` flag guards `logger.emit` as defense-in-depth (against Bun-version
  drift). The pump is pull/demand-driven — one source chunk read and enqueued
  per `pull` — so response bytes are never mutated and nothing buffers ahead of
  the consumer (backpressure preserved).
- **Trace context**: same strict `traceparent` parser as the Java side
  (`trace-context.ts`); ids minted with `crypto.getRandomValues`. The context
  rides per-request `AsyncLocalStorage`, and a connect-es interceptor on the
  SSR transport forwards the child `traceparent` (this hop's span as
  parent-id) on every backend RPC — that is what makes the SSR and Java events
  share a `trace_id`, with the backend's `parent_span_id` = the SSR `span_id`.
- **`connect_code` / `rpc_method`**: always `null` on the SSR side (it serves
  HTML routes, not Connect RPCs); the key set stays identical.
- **Stack cap**: `error.stack` is capped to **20 frames and 8KB** (with
  truncation markers). Rationale: container log drivers chunk one stdout write
  at ~16KB and each chunk becomes its own log record, which would shred the
  JSON line — the Java side's known caveat, closed here by construction.
- **Redaction**: pino `redact` censors `attributes.authorization` /
  `attributes.cookie` / `attributes.password` / `attributes.token`. The
  current schema carries no sensitive values; the paths are a forward-looking
  guard for anything future code adds to `attributes`.

## Browser variant (iq2.4)

The client also emits wide events and propagates trace context — but the unit is
one **USER ACTION**, not an HTTP request. This matters because a browser's RPCs
go **browser→Java directly, bypassing the SSR middleware**: the SSR event never
sees them, so a client-side interceptor is their **only** trace source.

Implemented in `services/web-ui-ssr/src/observability/browser-events.ts`, wired
into the sole client transport (`src/transport-client.ts`) and the mutation hooks
(`src/queries/todos.ts`) + router navigation events (`src/entry-client.tsx`).

- **No OpenTelemetry web SDK.** The OTel browser SDK is 25–60kB gz on the
  hydration-critical path and was rejected. This path reuses the existing
  isomorphic `trace-context.ts` (it imports nothing, so no server-only code
  leaks into the client bundle) plus LogLayer's built-in `ConsoleTransport`.
  Measured client-JS bundle delta for the whole feature: **≈ +6.4 kB gz**
  (baseline ≈ 201.6 kB → ≈ 208.1 kB, summed gzipped initial+async chunks),
  inside the < 9 kB research budget.
- **One trace per action, fresh span per RPC.** An *action* mints ONE `trace_id`
  (shared by its whole span tree). The client transport interceptor stamps every
  outbound RPC with a child `traceparent` = that `trace_id` + a **fresh span per
  call** (the client span the backend records as its `parent_span_id`). Actions
  are the natural user-action seams: the mutation flows (`create_todo`,
  `toggle_todo`, `edit_todo_details`, `delete_todo`) and route navigations
  (`navigate`). IDs are minted with `crypto.getRandomValues` (works in an
  insecure context, unlike `crypto.randomUUID`), flags `01`.
- **Emission.** One event per action, on completion (success or throw), via
  LogLayer → `ConsoleTransport` as a single JSON line (schema fields flat at the
  root plus a `message` marker), so it is both human-scannable and
  machine-parseable. `console` only for now.
- **CORS.** Because the browser now sends a `traceparent` on cross-origin RPCs,
  the backend CORS preflight must advertise it: `Traceparent` is added to
  `ConnectCors.ALLOWED_HEADERS` (the one deliberate divergence from connect-es's
  header list).

### Browser field schema

Same names/semantics as the server schema where they overlap; the server-only
HTTP/RPC fields are dropped and action fields are added. `component` is always
`"web-ui-browser"`.

| JSON key       | Type              | Nullable | Description |
|----------------|-------------------|----------|-------------|
| `trace_id`     | string (32 hex)   | no       | The action's trace id (one per user action). |
| `span_id`      | string (16 hex)   | no       | The action's root span id. Each RPC additionally mints its own child span (sent as the RPC's `traceparent` parent-id); those are not individually logged. |
| `timestamp`    | string (ISO-8601) | no       | Instant the action finished. |
| `duration_ms`  | number            | no       | Wall time of the action. |
| `component`    | string            | no       | Always `"web-ui-browser"`. |
| `action`       | string            | no       | `create_todo` \| `toggle_todo` \| `edit_todo_details` \| `delete_todo` \| `navigate`. |
| `rpc_count`    | number            | no       | RPCs the action issued. |
| `rpc_failures` | number            | no       | Of those, how many rejected. |
| `error`        | object            | **yes**  | `{ type, message }` when the action threw; else `null`. No stack (kept lean). |

### Pragmatic boundaries (honest gaps)

- **No AsyncLocalStorage in the browser.** The active action is a module-level
  reference; JS being single-threaded, the interceptor (which runs synchronously
  when a call is issued) always reads the correct action for any *synchronously
  issued* RPC. While two actions actually *overlap*, an RPC is attributed to the
  most recently begun action still active at the instant it is issued.
- **Overlap completion is order-safe (FIFO-safe).** Overlapping actions may
  settle in ANY order (A begins, B begins, A settles first — reachable via
  mutation-during-navigation). `endAction` marks a context *ended*, restores
  activation only when the ending context is itself the active one, and walks
  the `previous` chain past ended contexts — so a dead, already-emitted action
  can never become active again, and once all overlapping actions settle no
  action is active. `endAction` is also idempotent (a scope closed twice emits
  once), which is what makes the navigation scope's redundant close paths safe.
- **Background refetches are unattributed.** An RPC issued outside any action
  (e.g. a TanStack Query settle-refetch that fires after the mutation resolves)
  carries no `traceparent`; the backend simply starts a fresh trace. This is
  correct — such refetches are not user actions — and it holds in the overlap
  case too (guaranteed by the FIFO-safety above).
- **Navigation error path.** This router version's `RouterEvents` has no error
  event. The navigate scope is closed on every terminal signal available:
  supersede (a new navigation closes the previous scope), `onResolved` — which
  the Solid Transitioner emits purely off the router's pending→idle flip, NOT
  off load success, so it also fires when a navigation's loader errors — and an
  `onRendered` backstop (harmless double-close thanks to idempotent
  `endAction`).

### Later shipping path (design note, not implemented)

Console is the sink for now. The intended production path keeps the same event
schema but changes only the transport:

1. Buffer events in memory and flush a batch as one JSON array to a collector
   endpoint (`POST /client-events`) on a short timer / when the batch fills.
2. On page teardown (`visibilitychange` → hidden / `pagehide`), flush the tail
   with `navigator.sendBeacon` — it survives unload where `fetch` would be
   cancelled. Keep beacon bodies small (browsers cap them, commonly 64 KB).
3. The collector stamps server-received time and forwards to the same log/trace
   pipeline the server wide events use, so browser and backend events remain one
   queryable stream keyed on `trace_id`.

This is a transport swap behind the existing `browser-events.ts` sink seam
(`setActionEventSink`), so no call sites change.
