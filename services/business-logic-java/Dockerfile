# Build stage: regenerate the protobuf/gRPC Java sources from proto/ and
# build the runnable jar. Codegen is self-contained: the protoc and
# protoc-gen-grpc-java binaries are fetched from Maven Central at the versions
# pinned by the ARGs below (protoc 4.34.0 ⇒ gencode 4.34.0; grpc-java 1.80.0).
# These are pinned INDEPENDENTLY of the nix dev shell (whose nixpkgs protoc is
# 35.1 ⇒ gencode 4.35.1); both satisfy pom.xml's invariant — gencode ≤ the
# protobuf-java 4.35.1 runtime and grpc-java plugin ≤ the grpc 1.82.2 runtime.
# So the build never depends on host-generated gitignored sources.
FROM maven:3.9.16-eclipse-temurin-25 AS build

WORKDIR /build

ARG TARGETARCH
ARG PROTOC_VERSION=4.34.0
ARG GRPC_JAVA_VERSION=1.80.0
# Keep in sync with version.protovalidate in pom.xml: the same jar that
# evaluates the constraints at runtime also ships buf/validate/validate.proto
# for codegen.
ARG PROTOVALIDATE_VERSION=1.2.2

# Fetch the codegen plugin binaries for the build platform via Maven
# (no curl, no extra apt packages; TARGETARCH is amd64/arm64 under BuildKit).
# The standalone protoc binary does not bundle the well-known-type protos
# (buf supplies them implicitly on the host), so extract google/protobuf/*.proto
# from the version-matched protobuf-java jar into an include dir. Same for
# buf/validate/validate.proto (imported by todo.proto for its protovalidate
# constraints; buf resolves it from the BSR dep on the host): extract it from
# the build.buf:protovalidate jar.
RUN case "${TARGETARCH}" in \
    amd64) PROTO_ARCH="linux-x86_64" ;; \
    arm64) PROTO_ARCH="linux-aarch_64" ;; \
    *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2 && exit 1 ;; \
    esac && \
    mvn -q org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy \
    -Dartifact="com.google.protobuf:protoc:${PROTOC_VERSION}:exe:${PROTO_ARCH}" \
    -DoutputDirectory=/opt/protoc -Dmdep.stripClassifier=true -Dmdep.stripVersion=true && \
    mvn -q org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy \
    -Dartifact="io.grpc:protoc-gen-grpc-java:${GRPC_JAVA_VERSION}:exe:${PROTO_ARCH}" \
    -DoutputDirectory=/opt/protoc -Dmdep.stripClassifier=true -Dmdep.stripVersion=true && \
    mvn -q org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy \
    -Dartifact="com.google.protobuf:protobuf-java:${PROTOC_VERSION}" \
    -DoutputDirectory=/opt/protoc -Dmdep.stripVersion=true && \
    mvn -q org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy \
    -Dartifact="build.buf:protovalidate:${PROTOVALIDATE_VERSION}" \
    -DoutputDirectory=/opt/protoc -Dmdep.stripVersion=true && \
    jar --extract --file /opt/protoc/protobuf-java.jar --dir /opt/protoc/include google/protobuf && \
    jar --extract --file /opt/protoc/protovalidate.jar --dir /opt/protoc/include buf/validate && \
    chmod +x /opt/protoc/protoc.exe /opt/protoc/protoc-gen-grpc-java.exe

# Regenerate the Java sources buf emits on the host (buf.gen.yaml: protoc's
# builtin java generator + protoc-gen-grpc-java, module root proto/)
COPY proto proto
RUN mkdir -p services/business-logic-java/generated-sources/protobuf \
    services/business-logic-java/generated-sources/grpc \
    && /opt/protoc/protoc.exe -Iproto -I/opt/protoc/include \
        --plugin=protoc-gen-grpc-java=/opt/protoc/protoc-gen-grpc-java.exe \
        --java_out=services/business-logic-java/generated-sources/protobuf \
        --grpc-java_out=services/business-logic-java/generated-sources/grpc \
        proto/todo/v1/todo.proto

# Build the runnable jar + target/libs/ (tests run in CI, not in image builds).
# De-reactored (517): no root aggregator pom. Build the Java units standalone in
# dependency order — install the shared build-bom BOM pom and the connect-unary-adapter
# jar into the image's ~/.m2, then package business-logic-java against them.
# copy-dependencies drops the adapter jar into target/libs/ (referenced by the runnable
# jar's Class-Path manifest). packages/java carries build-bom + connect-unary-adapter.
#
# .mvn is REQUIRED: it holds jvm.config's ten add-exports/add-opens for jdk.compiler
# that Error Prone needs on JDK 16+ (javac runs in-process, fork=false), and it fixes
# maven.multiModuleProjectDirectory (walked up from /build). Without it every unit's
# compile dies with an IllegalAccessError from the Error Prone plugin. mvn discovers it
# by walking up from each pom, so a single copy at /build/.mvn serves all three units.
# The hermetic jOOQ codegen (scripts/jooq-codegen.sh, run at generate-sources) needs
# postgres server+client binaries (initdb/pg_ctl/createdb) on PATH — the same tools
# the nix dev shell supplies via postgresql_17 — plus a NON-ROOT user, since initdb refuses to
# run as root. Install postgres, symlink its versioned server bindir onto PATH, and add
# a build user. (Version-pin lint waived: the base image's apt suite floats with its tag.)
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql \
    && ln -sf /usr/lib/postgresql/*/bin/initdb /usr/lib/postgresql/*/bin/pg_ctl \
        /usr/lib/postgresql/*/bin/createdb /usr/lib/postgresql/*/bin/postgres /usr/local/bin/ \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash builder

COPY .mvn .mvn
COPY packages/java packages/java
COPY services/business-logic-java/pom.xml services/business-logic-java/pom.xml
COPY services/business-logic-java/src services/business-logic-java/src
# scripts/ carries jooq-codegen.sh, which exec-maven-plugin runs at generate-sources.
COPY services/business-logic-java/scripts services/business-logic-java/scripts

# Run the build as the non-root `builder` (initdb refuses root). chown the build tree —
# including the buf/protoc sources generated above as root — so builder can read+write
# it; the maven local repo then lives under /home/builder/.m2.
RUN chown -R builder:builder /build
USER builder
# No bare -q: it swallows Error Prone's compile diagnostics into a bare "unknown
# compilation problem". -B keeps the log non-interactive; -e surfaces stack traces.
#
# The adapter is `install`ed (into the image ~/.m2) so the service resolves it — but
# `install` pulls in the `verify` phase, and the spotless/pmd/checkstyle gates bound
# there read tooling/ configs that are NOT in the image (and an image build has no
# business style-gating). Skip them exactly as the nix build does; they run in CI. The
# service stops at `package` (before `verify`), so it needs no skips.
RUN mvn -B -e -N install -f packages/java/build-bom/pom.xml \
    && mvn -B -e -DskipTests -Dspotless.check.skip=true -Dpmd.skip=true -Dcpd.skip=true -Dcheckstyle.skip=true \
        install -f packages/java/connect-unary-adapter/pom.xml \
    && mvn -B -e -DskipTests package -f services/business-logic-java/pom.xml

# Runtime stage: JRE only
FROM eclipse-temurin:25-jre AS runtime

WORKDIR /app
COPY --from=build /build/services/business-logic-java/target/libs libs
COPY --from=build /build/services/business-logic-java/target/business-logic-java.jar business-logic-java.jar

# Service configuration is owned by avaje-config (application.yaml, packaged
# inside the jar). CONFIG_PROFILES=docker layers application-docker.yaml on top,
# whose db.url default targets the compose-network `postgres` service host.
# PORT / DATABASE_URL / DATABASE_USERNAME / DATABASE_PASSWORD environment
# variables still override these file values (env > profile file), so compose's
# DATABASE_* injection and the ci-e2e app's PORT/DATABASE_URL keep working.
# Secrets (DATABASE_PASSWORD) come from the environment, never the image.
ENV CONFIG_PROFILES=docker
ENV PORT=3001
EXPOSE 3001
CMD ["java", "-jar", "business-logic-java.jar"]
