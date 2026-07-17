# Build stage: regenerate the protobuf/gRPC Java sources from proto/ and
# build the runnable jar. Codegen is self-contained: the protoc and
# protoc-gen-grpc-java binaries are fetched from Maven Central (same versions
# devenv pins via nixpkgs: protoc 34.0 == 4.34.0, protoc-gen-grpc-java 1.80.0),
# so the build never depends on host-generated gitignored sources.
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
# The Connect-unary adapter is a separate reactor module, so build from the root
# aggregator pom: Maven builds packages/java/connect-unary-adapter first, then
# business-logic-java against it, and copy-dependencies drops the adapter jar
# into target/libs/ (referenced by the runnable jar's Class-Path manifest).
COPY pom.xml pom.xml
COPY packages/java packages/java
COPY services/business-logic-java/pom.xml services/business-logic-java/pom.xml
COPY services/business-logic-java/src services/business-logic-java/src
RUN mvn -q -f pom.xml -DskipTests package

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
# DATABASE_* injection and the devenv e2e task's PORT/DATABASE_URL keep working.
# Secrets (DATABASE_PASSWORD) come from the environment, never the image.
ENV CONFIG_PROFILES=docker
ENV PORT=3001
EXPOSE 3001
CMD ["java", "-jar", "business-logic-java.jar"]
