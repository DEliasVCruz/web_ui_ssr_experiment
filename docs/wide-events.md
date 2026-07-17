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
