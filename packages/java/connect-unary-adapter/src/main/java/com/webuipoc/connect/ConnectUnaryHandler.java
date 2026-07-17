package com.webuipoc.connect;

import build.buf.protovalidate.ValidationResult;
import build.buf.protovalidate.Validator;
import build.buf.protovalidate.Violation;
import build.buf.protovalidate.exceptions.ValidationException;
import build.buf.validate.FieldPath;
import build.buf.validate.FieldPathElement;
import com.google.protobuf.Message;
import com.google.protobuf.util.JsonFormat;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerMethodDefinition;
import io.grpc.ServerServiceDefinition;
import io.grpc.Status;
import io.helidon.common.uri.UriQuery;
import io.helidon.http.HeaderName;
import io.helidon.http.HeaderNames;
import io.helidon.http.Method;
import io.helidon.webserver.http.Handler;
import io.helidon.webserver.http.ServerRequest;
import io.helidon.webserver.http.ServerResponse;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.jspecify.annotations.Nullable;

/**
 * Handles Connect-unary HTTP requests
 * ({@code POST /{package}.{Service}/{Method}}, and {@code GET} for idempotent
 * RPCs) for one registered {@link ServerServiceDefinition}, per the Connect
 * protocol (https://connectrpc.com/docs/protocol/):
 *
 * <ul>
 *   <li><b>GET (idempotent RPCs)</b>: a method whose descriptor is
 *       {@link MethodDescriptor#isSafe() safe} (grpc-java sets this from
 *       {@code idempotency_level = NO_SIDE_EFFECTS} in the proto) may be called
 *       with {@code GET /{Service}/{Method}?connect=v1&encoding=<proto|json>&message=<payload>[&base64=1][&compression=identity]}.
 *       The request codec comes from the {@code encoding} parameter (not a
 *       Content-Type header); {@code connect=v1} is required (GET carries no
 *       {@code connect-protocol-version} header); the {@code message} parameter
 *       is base64url-decoded when {@code base64=1}, otherwise taken as the
 *       already percent-decoded UTF-8 payload; an empty/absent {@code message}
 *       is an empty request body. Validation, dispatch, response-codec mirroring
 *       and error mapping are identical to POST. A GET to a non-safe method is
 *       rejected with HTTP 405 (mirroring connect-es).</li>
 *   <li>Request/response bodies are bare serialized messages (no envelope).</li>
 *   <li>Codecs: {@code application/proto} (binary) and {@code application/json}
 *       (protobuf-java-util {@link JsonFormat}); the response mirrors the
 *       request codec. Any other content type → HTTP 415.</li>
 *   <li>Errors: non-200 status per the spec's code table ({@link ConnectCode})
 *       with an {@code application/json} body {@code {"code": ..., "message": ...}},
 *       regardless of the request codec.</li>
 *   <li>protovalidate: every successfully parsed request message is checked
 *       against its {@code buf.validate.*} constraints before the call is
 *       dispatched. Violations map to {@code invalid_argument} (HTTP 400) with
 *       the violated field paths and rule messages in the error message; a
 *       {@link ValidationException} (validator infrastructure failure, not a
 *       violation) maps to {@code internal}.</li>
 *   <li>{@code connect-protocol-version}: accepted but not required (connect-es
 *       always sends {@code 1}); a present-but-unsupported version is rejected
 *       with {@code invalid_argument}.</li>
 *   <li>{@code content-encoding}: absent means {@code identity}; any other
 *       encoding is rejected with {@code unimplemented} listing the supported
 *       encodings, as the spec mandates.</li>
 *   <li>{@code connect-timeout-ms}: honored by bounding the wait for the
 *       (possibly asynchronous) in-process handler to complete; on expiry the
 *       call is marked cancelled, the listener is notified, and the response is
 *       {@code deadline_exceeded}. The deadline is <em>not</em> propagated as a
 *       {@code io.grpc.Context} deadline, and a handler that blocks its calling
 *       thread is not interrupted mid-flight. Without the header the spec
 *       mandates an infinite timeout, so the outcome wait is unbounded: an
 *       asynchronous handler that never closes its call pins the request (and
 *       its virtual thread) forever. Known and acceptable for synchronous
 *       services; async implementations must guarantee they terminate every
 *       call.</li>
 *   <li>Unknown method (or a non-unary method): HTTP 404 with a
 *       {@code {"code":"unimplemented"}} body — the spec's HTTP-to-Connect
 *       table maps 404 to {@code unimplemented}, and the explicit body keeps
 *       Connect clients from having to infer it.</li>
 * </ul>
 *
 * <p>Dispatch is purely descriptor-driven ({@link ServerMethodDefinition} +
 * the method handlers produced by {@code io.grpc.stub.ServerCalls}), so any
 * {@code BindableService} works; nothing here references a concrete service.
 */
final class ConnectUnaryHandler implements Handler {

    private static final HeaderName CONTENT_TYPE = HeaderNames.CONTENT_TYPE;
    private static final HeaderName CONTENT_ENCODING = HeaderNames.create("Content-Encoding");
    private static final HeaderName CONNECT_PROTOCOL_VERSION = HeaderNames.create("Connect-Protocol-Version");
    private static final HeaderName CONNECT_TIMEOUT_MS = HeaderNames.create("Connect-Timeout-Ms");
    private static final HeaderName ALLOW = HeaderNames.create("Allow");

    private static final String CONTENT_TYPE_PROTO = "application/proto";
    private static final String CONTENT_TYPE_JSON = "application/json";
    private static final String SUPPORTED_PROTOCOL_VERSION = "1";
    private static final String TRAILER_PREFIX = "trailer-";
    /** Spec: "the value of the Timeout portion ... is one to ten digits". */
    private static final int MAX_TIMEOUT_DIGITS = 10;

    // Connect GET query parameters (Connect protocol "Unary-Get-Request").
    private static final String PARAM_CONNECT = "connect";
    private static final String PARAM_ENCODING = "encoding";
    private static final String PARAM_MESSAGE = "message";
    private static final String PARAM_BASE64 = "base64";
    private static final String PARAM_COMPRESSION = "compression";
    /** GET carries the protocol version as {@code connect=v1} (no header). */
    private static final String CONNECT_VERSION_VALUE = "v" + SUPPORTED_PROTOCOL_VERSION;

    private static final String ENCODING_PROTO = "proto";
    private static final String ENCODING_JSON = "json";

    /**
     * The HTTP "no transformation" content-coding token (RFC 9110 §8.4.1): the default
     * for both the GET {@code compression} query param and the Content-Encoding header,
     * and the only coding this adapter supports.
     */
    private static final String ENCODING_IDENTITY = "identity";

    private enum Codec {
        PROTO,
        JSON
    }

    private final Map<String, ServerMethodDefinition<?, ?>> unaryMethods = new HashMap<>();
    private final Validator validator;

    ConnectUnaryHandler(ServerServiceDefinition service, Validator validator) {
        this.validator = validator;
        for (ServerMethodDefinition<?, ?> method : service.getMethods()) {
            if (method.getMethodDescriptor().getType() == MethodDescriptor.MethodType.UNARY) {
                unaryMethods.put("/" + method.getMethodDescriptor().getFullMethodName(), method);
            }
        }
    }

    @Override
    public void handle(ServerRequest req, ServerResponse res) throws Exception {
        String path = req.prologue().uriPath().path();
        ServerMethodDefinition<?, ?> method = unaryMethods.get(path);
        if (method == null) {
            // 404 so plain HTTP clients see "not found"; the body carries the
            // Connect code the spec's HTTP-to-Connect table infers from 404.
            sendError(res, 404, ConnectCode.UNIMPLEMENTED, "no unary RPC " + path + " on this server", null);
            return;
        }

        if (req.prologue().method() == Method.GET) {
            handleGet(req, res, method, path);
        } else {
            handlePost(req, res, method);
        }
    }

    /**
     * Handles a Connect GET request (idempotent RPCs). The codec and payload
     * come from query parameters instead of the Content-Type header and body;
     * everything downstream (validation, dispatch, response, errors) is shared
     * with POST via {@link #invokeUnary}.
     */
    private void handleGet(ServerRequest req, ServerResponse res, ServerMethodDefinition<?, ?> method, String path) {
        // GET is only valid for side-effect-free RPCs (idempotency_level =
        // NO_SIDE_EFFECTS, which grpc-java surfaces as MethodDescriptor.isSafe()).
        // connect-es returns a bare HTTP 405 here; we mirror the 405 status and
        // add the adapter's standard JSON error body plus an Allow header.
        if (!method.getMethodDescriptor().isSafe()) {
            res.header(ALLOW, "POST");
            sendError(
                    res,
                    405,
                    ConnectCode.UNIMPLEMENTED,
                    "GET is not supported for " + path + "; only NO_SIDE_EFFECTS methods may be called with GET",
                    null);
            return;
        }

        UriQuery query = req.query();

        // connect=v1 is required: GET carries no connect-protocol-version header,
        // so this parameter both selects the protocol and its version.
        if (query.first(PARAM_CONNECT).isEmpty()) {
            sendError(
                    res,
                    ConnectCode.INVALID_ARGUMENT,
                    "missing required parameter: set connect to \"" + CONNECT_VERSION_VALUE + "\"",
                    null);
            return;
        }
        String connect = query.first(PARAM_CONNECT).get();
        if (!CONNECT_VERSION_VALUE.equals(connect.trim())) {
            sendError(
                    res,
                    ConnectCode.INVALID_ARGUMENT,
                    "connect must be \"" + CONNECT_VERSION_VALUE + "\": got \"" + connect + "\"",
                    null);
            return;
        }

        // compression defaults to identity; only identity is supported.
        String compression = query.first(PARAM_COMPRESSION).map(String::trim).orElse(ENCODING_IDENTITY);
        if (!ENCODING_IDENTITY.equalsIgnoreCase(compression)) {
            sendError(
                    res,
                    ConnectCode.UNIMPLEMENTED,
                    "unsupported compression \"" + compression + "\"; supported compressions are: identity",
                    null);
            return;
        }

        Codec codec = codecForEncoding(query.first(PARAM_ENCODING).orElse(null), method);
        if (codec == null) {
            // Spec: an unsupported/missing encoding → HTTP 415 (connect-es maps a
            // missing encoding query param to the same "unsupported media type").
            res.status(io.helidon.http.Status.UNSUPPORTED_MEDIA_TYPE_415).send();
            return;
        }

        Long timeoutMs;
        try {
            // connect-es keeps the connect-timeout-ms header on GET requests.
            timeoutMs = parseTimeoutMs(req.headers().first(CONNECT_TIMEOUT_MS));
        } catch (IllegalArgumentException e) {
            sendError(res, ConnectCode.INVALID_ARGUMENT, e.getMessage(), null);
            return;
        }

        boolean base64 = "1".equals(query.first(PARAM_BASE64).map(String::trim).orElse(null));
        byte[] body;
        try {
            body = decodeMessageParam(query, base64);
        } catch (IllegalArgumentException e) {
            sendError(
                    res,
                    ConnectCode.INVALID_ARGUMENT,
                    "failed to decode base64 message parameter: " + e.getMessage(),
                    null);
            return;
        }

        invokeUnary(method, codec, body, req, res, timeoutMs);
    }

    /** Handles a Connect POST request (any unary RPC). */
    private void handlePost(ServerRequest req, ServerResponse res, ServerMethodDefinition<?, ?> method)
            throws Exception {
        Optional<String> protocolVersion = req.headers().first(CONNECT_PROTOCOL_VERSION);
        if (protocolVersion.isPresent()
                && !SUPPORTED_PROTOCOL_VERSION.equals(protocolVersion.get().trim())) {
            sendError(
                    res,
                    ConnectCode.INVALID_ARGUMENT,
                    "connect-protocol-version must be \"1\": got \"" + protocolVersion.get() + "\"",
                    null);
            return;
        }

        // Absent content-encoding means identity (standard HTTP semantics); any
        // other encoding must be rejected with code unimplemented, with a
        // message listing the supported encodings (spec, "Unary Request").
        String encoding =
                req.headers().first(CONTENT_ENCODING).orElse(ENCODING_IDENTITY).trim();
        if (!ENCODING_IDENTITY.equalsIgnoreCase(encoding)) {
            sendError(
                    res,
                    ConnectCode.UNIMPLEMENTED,
                    "unsupported content-encoding \"" + encoding + "\"; supported encodings are: identity",
                    null);
            return;
        }

        Codec codec = negotiateCodec(req, method);
        if (codec == null) {
            // Spec: unsupported codec → HTTP 415 Unsupported Media Type.
            res.status(io.helidon.http.Status.UNSUPPORTED_MEDIA_TYPE_415).send();
            return;
        }

        Long timeoutMs;
        try {
            timeoutMs = parseTimeoutMs(req.headers().first(CONNECT_TIMEOUT_MS));
        } catch (IllegalArgumentException e) {
            sendError(res, ConnectCode.INVALID_ARGUMENT, e.getMessage(), null);
            return;
        }

        byte[] body;
        try (InputStream in = req.content().inputStream()) {
            body = in.readAllBytes();
        }

        invokeUnary(method, codec, body, req, res, timeoutMs);
    }

    private <ReqT, RespT> void invokeUnary(
            ServerMethodDefinition<ReqT, RespT> method,
            Codec codec,
            byte[] body,
            ServerRequest req,
            ServerResponse res,
            @Nullable Long timeoutMs) {
        MethodDescriptor<ReqT, RespT> descriptor = method.getMethodDescriptor();

        ReqT request;
        try {
            request = parseRequest(descriptor, codec, body);
        } catch (Exception e) {
            sendError(
                    res,
                    ConnectCode.INVALID_ARGUMENT,
                    "failed to decode " + codec.name().toLowerCase(Locale.ROOT) + " request message: " + e.getMessage(),
                    null);
            return;
        }

        if (request instanceof Message message) {
            ValidationResult validation;
            try {
                validation = validator.validate(message);
            } catch (ValidationException e) {
                // Validator infrastructure failure (rule compilation/evaluation),
                // not a constraint violation: the request may well be fine.
                sendError(res, ConnectCode.INTERNAL, "request validation failed: " + e.getMessage(), null);
                return;
            }
            if (!validation.isSuccess()) {
                sendError(res, ConnectCode.INVALID_ARGUMENT, describeViolations(validation), null);
                return;
            }
        }

        UnaryCapturingServerCall<ReqT, RespT> call = new UnaryCapturingServerCall<>(descriptor);
        ServerCall.Listener<ReqT> listener = null;
        try {
            listener = method.getServerCallHandler().startCall(call, HttpMetadata.fromRequestHeaders(req.headers()));
            listener.onMessage(request);
            listener.onHalfClose();
        } catch (Throwable t) {
            call.failIfPending(Status.fromThrowable(t), Status.trailersFromThrowable(t));
        }

        UnaryCapturingServerCall.Outcome<RespT> outcome;
        try {
            // No connect-timeout-ms → infinite timeout per spec: this wait is
            // unbounded, so an async handler that never closes its call pins
            // this request forever (see class javadoc).
            outcome = timeoutMs == null ? call.outcome().get() : call.outcome().get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            call.cancel();
            notifyCancel(listener);
            sendError(
                    res,
                    ConnectCode.DEADLINE_EXCEEDED,
                    "the operation timed out after " + timeoutMs + "ms (connect-timeout-ms)",
                    null);
            return;
        } catch (ExecutionException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            sendError(res, ConnectCode.INTERNAL, "in-process call failed: " + e.getMessage(), null);
            return;
        }

        if (!outcome.status().isOk()) {
            ConnectCode code = ConnectCode.fromGrpc(outcome.status().getCode());
            // Connect unary errors merge leading and trailing metadata into
            // plain response headers (connect-es sets error.metadata directly
            // on the response header, no "trailer-" prefix).
            Metadata errorMetadata = new Metadata();
            Metadata errorHeaders = outcome.headers();
            if (errorHeaders != null) {
                errorMetadata.merge(errorHeaders);
            }
            // Outcome.trailers is declared non-null, but it is populated from
            // UNANNOTATED grpc-java callers (ServerCall.close(status, trailers));
            // this null-check is deliberate defense-in-depth against a handler
            // passing null through that unchecked seam, not a contradiction of
            // the declared invariant.
            Metadata errorTrailers = outcome.trailers();
            if (errorTrailers != null) {
                errorMetadata.merge(errorTrailers);
            }
            sendError(res, code, outcome.status().getDescription(), errorMetadata);
            return;
        }

        RespT responseMessage = outcome.message();
        if (responseMessage == null) {
            sendError(res, ConnectCode.INTERNAL, "unary call closed without a response message", null);
            return;
        }

        byte[] responseBody;
        try {
            responseBody = serializeResponse(descriptor, codec, responseMessage);
        } catch (Exception e) {
            sendError(res, ConnectCode.INTERNAL, "failed to encode response message: " + e.getMessage(), null);
            return;
        }

        notifyComplete(listener);
        HttpMetadata.writeToResponse(res, outcome.headers(), "");
        HttpMetadata.writeToResponse(res, outcome.trailers(), TRAILER_PREFIX);
        res.header(CONTENT_TYPE, codec == Codec.PROTO ? CONTENT_TYPE_PROTO : CONTENT_TYPE_JSON);
        res.status(io.helidon.http.Status.OK_200).send(responseBody);
    }

    /** Returns the codec for the request, or {@code null} if unsupported (→ 415). */
    private @Nullable Codec negotiateCodec(ServerRequest req, ServerMethodDefinition<?, ?> method) {
        Optional<String> contentType = req.headers().first(CONTENT_TYPE);
        if (contentType.isEmpty()) {
            return null;
        }
        String mediaType = contentType.get();
        int paramsStart = mediaType.indexOf(';');
        if (paramsStart >= 0) {
            mediaType = mediaType.substring(0, paramsStart);
        }
        mediaType = mediaType.trim().toLowerCase(Locale.ROOT);
        if (CONTENT_TYPE_PROTO.equals(mediaType)) {
            return Codec.PROTO;
        }
        if (CONTENT_TYPE_JSON.equals(mediaType)) {
            // JSON requires reflective access to protobuf messages; marshallers
            // that are not protobuf PrototypeMarshallers can only do binary.
            return supportsJson(method.getMethodDescriptor()) ? Codec.JSON : null;
        }
        return null;
    }

    /**
     * Returns the codec for a Connect GET {@code encoding} query parameter, or
     * {@code null} if unsupported/missing (→ 415). Mirrors
     * {@link #negotiateCodec}'s JSON-support check for the JSON codec.
     */
    private static @Nullable Codec codecForEncoding(@Nullable String encoding, ServerMethodDefinition<?, ?> method) {
        if (ENCODING_PROTO.equals(encoding)) {
            return Codec.PROTO;
        }
        if (ENCODING_JSON.equals(encoding)) {
            return supportsJson(method.getMethodDescriptor()) ? Codec.JSON : null;
        }
        return null;
    }

    /**
     * Decodes the Connect GET {@code message} query parameter into the raw
     * request bytes. When {@code base64} is set the value is base64url-decoded
     * (connect-es emits unpadded base64url; padded input is also accepted);
     * otherwise it is the already percent-decoded UTF-8 payload. An absent or
     * empty {@code message} yields an empty body (e.g. for empty request types
     * like {@code ListTodosRequest}).
     */
    private static byte[] decodeMessageParam(UriQuery query, boolean base64) {
        String message = query.first(PARAM_MESSAGE).orElse("");
        if (!base64) {
            return message.getBytes(StandardCharsets.UTF_8);
        }
        return decodeBase64Url(message);
    }

    /** Decodes url-safe base64, tolerating both padded and unpadded input. */
    private static byte[] decodeBase64Url(String value) {
        String core = value;
        while (core.endsWith("=")) {
            core = core.substring(0, core.length() - 1);
        }
        int remainder = core.length() % 4;
        if (remainder > 0) {
            core += "=".repeat(4 - remainder);
        }
        return Base64.getUrlDecoder().decode(core);
    }

    private static boolean supportsJson(MethodDescriptor<?, ?> descriptor) {
        return messagePrototype(descriptor.getRequestMarshaller()) != null
                && messagePrototype(descriptor.getResponseMarshaller()) != null;
    }

    private static @Nullable Message messagePrototype(MethodDescriptor.Marshaller<?> marshaller) {
        if (marshaller instanceof MethodDescriptor.PrototypeMarshaller<?> prototypeMarshaller
                && prototypeMarshaller.getMessagePrototype() instanceof Message message) {
            return message;
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static <ReqT> ReqT parseRequest(MethodDescriptor<ReqT, ?> descriptor, Codec codec, byte[] body)
            throws Exception {
        if (codec == Codec.PROTO) {
            return descriptor.parseRequest(new ByteArrayInputStream(body));
        }
        // JSON is only negotiated when supportsJson() confirmed a prototype exists
        // for both marshallers, so this is non-null on every reachable JSON path.
        Message prototype = Objects.requireNonNull(
                messagePrototype(descriptor.getRequestMarshaller()),
                "JSON codec requires a protobuf request prototype");
        Message.Builder builder = prototype.newBuilderForType();
        JsonFormat.parser().ignoringUnknownFields().merge(new String(body, StandardCharsets.UTF_8), builder);
        return (ReqT) builder.build();
    }

    private static <RespT> byte[] serializeResponse(MethodDescriptor<?, RespT> descriptor, Codec codec, RespT message)
            throws Exception {
        if (codec == Codec.PROTO) {
            try (InputStream stream = descriptor.streamResponse(message)) {
                return stream.readAllBytes();
            }
        }
        String json = JsonFormat.printer().omittingInsignificantWhitespace().print((Message) message);
        return json.getBytes(StandardCharsets.UTF_8);
    }

    /**
     * Renders protovalidate violations as one human-readable line per violation:
     * {@code invalid request: <field path>: <rule message> [<rule id>]}, joined
     * with {@code "; "}.
     */
    private static String describeViolations(ValidationResult result) {
        StringBuilder out = new StringBuilder("invalid request");
        String separator = ": ";
        for (Violation violation : result.getViolations()) {
            build.buf.validate.Violation proto = violation.toProto();
            out.append(separator);
            separator = "; ";
            String path = fieldPathString(proto.getField());
            if (!path.isEmpty()) {
                out.append(path).append(": ");
            }
            out.append(proto.getMessage());
            if (!proto.getRuleId().isEmpty()) {
                out.append(" [").append(proto.getRuleId()).append(']');
            }
        }
        return out.toString();
    }

    /** Joins a violation's field path elements with dots (e.g. {@code todo.title}). */
    private static String fieldPathString(FieldPath path) {
        StringBuilder out = new StringBuilder();
        for (FieldPathElement element : path.getElementsList()) {
            if (!out.isEmpty()) {
                out.append('.');
            }
            out.append(element.getFieldName());
        }
        return out.toString();
    }

    /**
     * Parses {@code connect-timeout-ms}. Spec: 1-10 ASCII digits; absence means
     * an infinite timeout.
     *
     * @return the timeout in milliseconds, or {@code null} for no timeout
     * @throws IllegalArgumentException if the header value is malformed
     */
    private static @Nullable Long parseTimeoutMs(Optional<String> header) {
        if (header.isEmpty()) {
            return null;
        }
        String value = header.get().trim();
        if (value.isEmpty()
                || value.length() > MAX_TIMEOUT_DIGITS
                || !value.chars().allMatch(Character::isDigit)) {
            throw new IllegalArgumentException("protocol error: invalid connect-timeout-ms value \"" + value + "\"");
        }
        return Long.parseLong(value);
    }

    private static void sendError(
            ServerResponse res, ConnectCode code, @Nullable String message, @Nullable Metadata metadata) {
        sendError(res, code.httpStatus(), code, message, metadata);
    }

    private static void sendError(
            ServerResponse res,
            int httpStatus,
            ConnectCode code,
            @Nullable String message,
            @Nullable Metadata metadata) {
        if (metadata != null) {
            HttpMetadata.writeToResponse(res, metadata, "");
        }
        res.header(CONTENT_TYPE, CONTENT_TYPE_JSON);
        res.status(io.helidon.http.Status.create(httpStatus))
                .send(ConnectErrorJson.toJson(code, message).getBytes(StandardCharsets.UTF_8));
    }

    private static void notifyCancel(ServerCall.@Nullable Listener<?> listener) {
        if (listener == null) {
            return;
        }
        try {
            listener.onCancel();
        } catch (RuntimeException e) {
            // The response is already decided; listener cleanup failures are not actionable.
        }
    }

    private static void notifyComplete(ServerCall.@Nullable Listener<?> listener) {
        if (listener == null) {
            return;
        }
        try {
            listener.onComplete();
        } catch (RuntimeException e) {
            // The response is already decided; listener cleanup failures are not actionable.
        }
    }
}
