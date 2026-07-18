# business-logic-java

The backend service: Java (Helidon SE) port of the retired Bun/TS
`services/business-logic` service (Connect protocol), with full behavioral
parity.

`Main` serves `todo.v1.TodoService` (PostgreSQL-backed,
`com.webuipoc.businesslogic.todo`) over the service-agnostic Connect-unary HTTP
adapter — a shared reactor module (`packages/java/connect-unary-adapter`, package
`com.webuipoc.connect`, see below) — plus `GET /health`. Persistence is a
HikariCP-pooled pgjdbc connection; `TodoDb` runs the Flyway migrations
(`src/main/resources/db/migration`, V1 baseline `todos` table) on startup before
the server binds.

Env contract (avaje-config `application.yaml`):

| Env var | Config key | Default |
| --- | --- | --- |
| `PORT` | `server.port` | `3001` |
| `DATABASE_URL` | `db.url` | `jdbc:postgresql://localhost:5432/todos` |
| `DATABASE_USERNAME` | `db.username` | `todos` |
| `DATABASE_PASSWORD` | `db.password` | _(empty; env-only secret)_ |
| `DB_POOL_MAX_SIZE` | `db.pool.max-size` | `16` |
| `DB_POOL_MIN_IDLE` | `db.pool.min-idle` | `4` |

The `docker` profile (`application-docker.yaml`, `CONFIG_PROFILES=docker`) shifts
the default `db.url` host to the compose-network `postgres` service. pgjdbc
tuning (`prepareThreshold=1`, statement-cache) is applied in `AppFactory` as
datasource properties, so a bare operator-supplied `DATABASE_URL` cannot drop it.

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

The **jOOQ metamodel** (`com.webuipoc.jooq`, under `target/generated-sources/jooq`,
also gitignored) is generated at Maven `generate-sources` by `scripts/jooq-codegen.sh`
(wired via exec-maven-plugin). The script is **hermetic — no container runtime /
Docker socket**: it `initdb`s a throwaway PostgreSQL from the devenv/nix
environment, starts it on a loopback port + a unix socket in a temp dir, applies
the Flyway migrations under `src/main/resources/db/migration`, runs jOOQ's
generator against the live catalog, then tears it all down. It needs only the
postgres binaries on `PATH` and a writable `TMPDIR`, so the identical steps run in
a future pure Nix build sandbox (task 2pk.3). Flyway + jOOQ run through the
module's `jooq-codegen` Maven profile, keeping their versions pinned to the
reactor. (The integration **tests** below still use Testcontainers/podman — that is
deliberate and separate from codegen.)

## Build & test

This service is a module of the root Maven reactor (`../../pom.xml`, which also
builds `packages/java/connect-unary-adapter`). Build and test the whole reactor
from the repo root — this is the CI gate:

```sh
mvn -q -f pom.xml verify
```

Tests run in two tiers, both wired into `mvn verify`:

- **surefire** (`*Test`) — the fast unit + component tests (the adapter's wire
  contract against an in-memory stub, the jOOQ repository and the config holder
  against a Testcontainers Postgres, the ArchUnit rules, …).
- **failsafe** (`*IT`) — the end-to-end integration suite. `TodoServiceContractIT`
  boots the **real** service (`Main.start()`: full avaje-inject graph + Flyway +
  Helidon `WebServer` on an ephemeral port) against a Testcontainers
  `postgres:17-alpine` and drives it over raw HTTP, pinning the Connect wire
  contract (binary POST, Connect GET, JSON debug codec, error envelopes,
  protovalidate rejections). It replaces the retired Bun `connect-contract-test.ts`.
  A running container runtime (the devenv podman machine) is required, exactly as
  for the repository tests. `mvn verify` runs failsafe after surefire.

## Run

Headless (the runnable jar — the reactor `mvn package` emits
`services/business-logic-java/target/business-logic-java.jar` with a `Class-Path`
manifest pointing at `target/libs/` — which includes the `connect-unary-adapter`
jar — so the jar must stay next to its `libs/` directory):

```sh
mvn -q -f pom.xml -DskipTests package
# Needs a reachable Postgres (see docker-compose.yml `postgres` service);
# Flyway migrates it on startup.
PORT=3001 DATABASE_URL=jdbc:postgresql://localhost:5432/todos \
    DATABASE_USERNAME=todos DATABASE_PASSWORD=todos \
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

### Idempotent create (client-supplied id)

`CreateTodoRequest` carries an optional `id` (explicit presence, uuid-validated —
the same rule `GetTodoRequest.id` uses). Omit it and the server mints a lowercase
UUIDv7 (the default; the only path the current UI takes). Supply it and the server
persists it verbatim, which makes create **idempotent, first-write-wins**:

```sh
# First write persists the row.
curl -X POST http://localhost:3001/todo.v1.TodoService/CreateTodo \
    -H 'Content-Type: application/json' \
    -d '{"title":"buy milk","id":"0190163d-8694-7afd-8912-1c3d4e5f6a7b"}'
# {"todo":{"id":"0190163d-…","title":"buy milk",…}}

# Re-sending the SAME id (a replayed offline-queue entry) returns the EXISTING
# row as a 200 success and IGNORES the new payload — the stored "buy milk" wins,
# "buy oat milk" is dropped. Never an upsert; created_at/updated_at unchanged.
curl -X POST http://localhost:3001/todo.v1.TodoService/CreateTodo \
    -H 'Content-Type: application/json' \
    -d '{"title":"buy oat milk","id":"0190163d-8694-7afd-8912-1c3d4e5f6a7b"}'
# {"todo":{"id":"0190163d-…","title":"buy milk",…}}   ← first-write-wins
```

This id is the replay key for the offline mutation queue
(`web_ui_ssr_experiment-1w9`): a crash mid-flush re-sends the identical queued
entry, and first-write-wins makes that re-send a no-op rather than a duplicate.
The uuid rule keeps arbitrary text out of the `id` column, and because a colliding
id resolves to a *read* of the existing row (never a write), a client cannot mutate
another row by guessing its id. Cross-tenant owner-scoping of ids is a documented
future concern — single-user experiment today. Implemented in
`TodoRepository.createTodo` as `INSERT … ON CONFLICT (id) DO NOTHING RETURNING *`
plus a conflict-fetch, both in one transaction (see its javadoc).

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
2. **runtime** (`eclipse-temurin:25-jre`): jar + `libs/`, `ENV PORT=3001`,
   `ENV CONFIG_PROFILES=docker`; set `DATABASE_URL` / `DATABASE_USERNAME` /
   `DATABASE_PASSWORD` to point at the Postgres service (compose does this).

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

## Contract test (integration suite)

The Connect wire contract is pinned end to end by `TodoServiceContractIT`
(`src/test/java/.../businesslogic/TodoServiceContractIT.java`), a JUnit 5 +
Testcontainers `*IT` run by failsafe under `mvn verify`. It boots the **real**
service through the production `Main.start()` seam (full avaje-inject graph +
Flyway + Helidon `WebServer` on an ephemeral port) against a real
`postgres:17-alpine`, then drives it over raw `java.net.http.HttpClient` — asserting
the exact bytes, headers and status codes: binary Connect POST round-trips,
Connect GET for the idempotent (`NO_SIDE_EFFECTS`) RPCs with the base64url
`message` parameter, GET rejection (`405`) on mutations, the JSON debug codec,
the always-JSON error envelope (`not_found` with the preserved message), and
protovalidate rejections (`invalid_argument` naming the field).

This replaces the retired cross-client Bun script (`scripts/connect-contract-test.ts`
and its `ContractTestServer` harness on a fixed `:3911`): the checks now run in
CI on every `mvn verify`, against the real database-backed service rather than an
in-memory stub, with no TS toolchain or manual two-shell dance. (The adapter's
wire behavior against an in-memory stub is still unit-tested in detail by
`ConnectUnaryAdapterTest`.)
