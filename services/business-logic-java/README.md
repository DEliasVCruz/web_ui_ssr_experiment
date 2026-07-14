# business-logic-java

The backend service: Java (Helidon SE) port of the retired Bun/TS
`services/business-logic` service (Connect protocol), with full behavioral
parity.

`Main` serves `todo.v1.TodoService` (SQLite-backed, `com.webuipoc.businesslogic.todo`)
over the service-agnostic Connect-unary HTTP adapter — a shared reactor module
(`packages/java/connect-unary-adapter`, package `com.webuipoc.connect`, see
below) — plus `GET /health`. One
`TodoDb` (one SQLite connection) per process — two connections on the same
WAL-mode file risk `SQLITE_BUSY`. Env: `PORT` (default 3001) and
`DATABASE_PATH` (default `./data/todos.db`).

## Toolchain (provided by devenv)

| Tool | Version | Source |
| --- | --- | --- |
| JDK | 25 (OpenJDK; nixpkgs `jdk25`, vendor varies by platform) | `devenv.nix` (`languages.java`) |
| Maven | 3.9.x | `devenv.nix` (`languages.java.maven`) |
| protoc | 34.0 | `devenv.nix` (`pkgs.protobuf`) |
| protoc-gen-grpc-java | 1.80.0 | `devenv.nix` (`pkgs.protoc-gen-grpc-java`) |

Pinned in `pom.xml`: Helidon `4.4.1`, protobuf-java `4.35.1`, grpc-java `1.82.2`.

Version constraints (protobuf 4.x enforces these at class-load time):

- `protobuf-java` (runtime) must be ≥ the protoc gencode version (currently
  `4.34.0` from nixpkgs protoc 34.0), same major version.
- `grpc-java` (runtime) should be ≥ the `protoc-gen-grpc-java` plugin version.

If a devenv/nixpkgs bump changes protoc or the grpc plugin, re-check these pins.

## Codegen

Buf is the single codegen orchestrator for the repo. The root `buf.gen.yaml`
emits the Java sources into `generated-sources/` here (gitignored, like
`packages/rpc/gen`), using protoc's builtin `java` generator and
`protoc-gen-grpc-java` as local buf plugins from devenv — fully offline.

From the repo root (inside `devenv shell`):

```sh
bun run generate   # buf generate → TS (packages/rpc/gen) + Java (here)
```

`generated-sources/protobuf` and `generated-sources/grpc` are wired into the
Maven build as extra source roots (build-helper-maven-plugin), so run codegen
once before the first Maven build.

## Build & test

This service is a module of the root Maven reactor (`../../pom.xml`, which also
builds `packages/java/connect-unary-adapter`). Build and test the whole reactor
from the repo root — this is the CI gate:

```sh
mvn -q -f pom.xml verify
```

## Run

Headless (the runnable jar — the reactor `mvn package` emits
`services/business-logic-java/target/business-logic-java.jar` with a `Class-Path`
manifest pointing at `target/libs/` — which includes the `connect-unary-adapter`
jar — so the jar must stay next to its `libs/` directory):

```sh
mvn -q -f pom.xml -DskipTests package
PORT=3001 DATABASE_PATH=./data/todos.db \
    java -jar services/business-logic-java/target/business-logic-java.jar
```

Or via Maven during development. `exec:java` must run against a single module,
so install the adapter to the local repo once (a reactor `exec:java` would also
try to run on the aggregator, which has no main class), then run the service
standalone:

```sh
mvn -q install -DskipTests          # builds + installs connect-unary-adapter
# default port 3001, override with PORT
mvn -q -f services/business-logic-java compile exec:java
PORT=4001 mvn -q -f services/business-logic-java compile exec:java
```

Then:

```sh
curl http://localhost:3001/health
# {"status":"ok"}
curl -X POST http://localhost:3001/todo.v1.TodoService/CreateTodo \
    -H 'Content-Type: application/json' -d '{"title":"hello"}'
# {"todo":{"id":"…","title":"hello","createdAt":"…","updatedAt":"…"}}
```

## Docker

`Dockerfile` (multi-stage, used by the root `docker-compose.yml`):

1. **build** (`maven:3.9.16-eclipse-temurin-25`): fetches `protoc` 4.34.0 and
   `protoc-gen-grpc-java` 1.80.0 from Maven Central (the same versions devenv
   pins via nixpkgs, arch-selected via `TARGETARCH`), regenerates the Java
   sources from `proto/`, then builds the reactor (`mvn -f pom.xml package`,
   copying in the root aggregator pom + `packages/java`), which builds
   `connect-unary-adapter` before this service. The build is self-contained:
   host-generated `generated-sources/` and `target/` are excluded by the root
   `.dockerignore`, so the image never depends on gitignored host state.
2. **runtime** (`eclipse-temurin:25-jre`): jar + `libs/`, `ENV PORT=3001`;
   set `DATABASE_PATH` to put the SQLite file on a volume.

```sh
docker build -f services/business-logic-java/Dockerfile .
```

## Connect-unary adapter (`packages/java/connect-unary-adapter`, `com.webuipoc.connect`)

The adapter is a standalone, service-neutral reactor module
(`com.webuipoc:connect-unary-adapter`); this service depends on its artifact.
Helidon has no native Connect support, so the adapter exposes any gRPC
`ServerServiceDefinition` / `BindableService` over the
[Connect protocol](https://connectrpc.com/docs/protocol/) for **unary** RPCs —
the shape the connect-es browser/SSR clients speak. Register it as a Helidon
routing feature:

```java
routing.addFeature(ConnectUnaryFeature.create(new MyServiceImpl()));
```

Dispatch is descriptor-driven (`ServerMethodDefinition` + the handlers built by
`io.grpc.stub.ServerCalls`, invoked in-process through a capturing
`ServerCall`), so the adapter references no concrete service type and no
per-method routes exist. Streaming methods are not exposed (`unimplemented`).

Protocol coverage:

- `POST /{package}.{Service}/{Method}`, bare (un-enveloped) request/response
  bodies.
- Codecs: `application/proto` and `application/json` (protobuf-java-util
  `JsonFormat`); the response mirrors the request codec; anything else → HTTP
  415.
- Errors: non-200 + JSON body `{"code": "...", "message": "..."}` (always JSON,
  whatever the request codec). Code table (`ConnectCode`), transcribed verbatim
  from the spec:

  | Connect code | HTTP status |
  | --- | --- |
  | `canceled` | 499 |
  | `unknown` | 500 |
  | `invalid_argument` | 400 |
  | `deadline_exceeded` | 504 |
  | `not_found` | 404 |
  | `already_exists` | 409 |
  | `permission_denied` | 403 |
  | `resource_exhausted` | 429 |
  | `failed_precondition` | 400 |
  | `aborted` | 409 |
  | `out_of_range` | 400 |
  | `unimplemented` | 501 |
  | `internal` | 500 |
  | `unavailable` | 503 |
  | `data_loss` | 500 |
  | `unauthenticated` | 401 |

- `connect-protocol-version: 1` accepted but not required; a present,
  unsupported version → `invalid_argument`.
- `content-encoding`: absent = `identity`; anything else → `unimplemented`
  listing supported encodings (per spec). No compression is implemented.
- `connect-timeout-ms`: honored by bounding the wait for the (possibly async)
  handler outcome; expiry cancels the captured call and responds
  `deadline_exceeded`. Limitation: the deadline is not propagated as an
  `io.grpc.Context` deadline, and a handler blocking its calling thread is not
  interrupted.
- Unknown method on a registered service → HTTP 404 with
  `{"code":"unimplemented"}` (the spec's HTTP→Connect table maps 404 to
  `unimplemented`); an entirely unknown service falls through to Helidon's
  plain 404.
- Error `details` are not emitted (`io.grpc.Status` carries none).
- CORS mirrors the Bun service (hono/cors + `cors` from
  `@connectrpc/connect`): `OPTIONS` preflight → 204 with
  `Access-Control-Allow-Origin: *` and the connect-es allow-lists; every
  response carries `Access-Control-Allow-Origin` +
  `Access-Control-Expose-Headers` (see `ConnectCors`).

## Cross-client contract test

The proof that real connect-es clients interoperate: a Bun script
(`scripts/connect-contract-test.ts`, deps in this directory's `package.json` —
a workspace member for the TS side only) drives the generated
`@web-ui-poc/rpc` TodoService client over
`createConnectTransport({ useBinaryFormat: true })` from
`@connectrpc/connect-node` against the Java adapter serving the
`StubTodoService` test fixture.

```sh
# 1. install the adapter to the local repo once, then serve the stub through it
#    (foreground; PORT overrides 3911). exec:java runs against a single module,
#    so run it on the service alone rather than a reactor (-am) invocation.
mvn -q install -DskipTests
mvn -q -f services/business-logic-java test-compile exec:java \
    -DmainClass=com.webuipoc.connect.ContractTestServer \
    -Dexec.classpathScope=test

# 2. in another shell
bun run --filter @web-ui-poc/business-logic-java contract-test
```

It asserts round-trips (`getTodo`, `createTodo`, `listTodos`) and that a
`NOT_FOUND` from the service surfaces as a `ConnectError` with code
`NotFound` and the original message. CI wiring is a follow-up task.
