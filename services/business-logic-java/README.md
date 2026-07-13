# business-logic-java

Java (Helidon SE) port of `services/business-logic` (Bun/TS, Connect protocol).

**Status: scaffold only.** The server exposes `GET /health` (same JSON shape as
the Bun service) and the build compiles the buf-generated protobuf messages and
TodoService gRPC stubs for `proto/todo/v1/todo.proto`. The TodoService business
logic lands in a later task.

## Toolchain (provided by devenv)

| Tool | Version | Source |
| --- | --- | --- |
| JDK | 25 (Zulu) | `devenv.nix` (`languages.java`) |
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

```sh
mvn -q -f services/business-logic-java verify
```

## Run

```sh
# default port 3001, override with PORT
mvn -q -f services/business-logic-java compile exec:java
PORT=4001 mvn -q -f services/business-logic-java compile exec:java
```

Then:

```sh
curl http://localhost:3001/health
# {"status":"ok"}
```
