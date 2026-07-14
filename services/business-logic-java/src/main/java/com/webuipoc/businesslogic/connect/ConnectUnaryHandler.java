package com.webuipoc.businesslogic.connect;

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
import io.helidon.http.HeaderName;
import io.helidon.http.HeaderNames;
import io.helidon.webserver.http.Handler;
import io.helidon.webserver.http.ServerRequest;
import io.helidon.webserver.http.ServerResponse;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Handles Connect-unary HTTP requests ({@code POST /{package}.{Service}/{Method}})
 * for one registered {@link ServerServiceDefinition}, per the Connect protocol
 * (https://connectrpc.com/docs/protocol/):
 *
 * <ul>
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

    private static final String CONTENT_TYPE_PROTO = "application/proto";
    private static final String CONTENT_TYPE_JSON = "application/json";
    private static final String SUPPORTED_PROTOCOL_VERSION = "1";
    private static final String TRAILER_PREFIX = "trailer-";
    /** Spec: "the value of the Timeout portion ... is one to ten digits". */
    private static final int MAX_TIMEOUT_DIGITS = 10;

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
            sendError(res, 404, ConnectCode.UNIMPLEMENTED,
                    "no unary RPC " + path + " on this server", null);
            return;
        }

        Optional<String> protocolVersion = req.headers().first(CONNECT_PROTOCOL_VERSION);
        if (protocolVersion.isPresent() && !SUPPORTED_PROTOCOL_VERSION.equals(protocolVersion.get().trim())) {
            sendError(res, ConnectCode.INVALID_ARGUMENT,
                    "connect-protocol-version must be \"1\": got \"" + protocolVersion.get() + "\"", null);
            return;
        }

        // Absent content-encoding means identity (standard HTTP semantics); any
        // other encoding must be rejected with code unimplemented, with a
        // message listing the supported encodings (spec, "Unary Request").
        String encoding = req.headers().first(CONTENT_ENCODING).orElse("identity").trim();
        if (!"identity".equalsIgnoreCase(encoding)) {
            sendError(res, ConnectCode.UNIMPLEMENTED,
                    "unsupported content-encoding \"" + encoding + "\"; supported encodings are: identity", null);
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

    private <ReqT, RespT> void invokeUnary(ServerMethodDefinition<ReqT, RespT> method,
                                           Codec codec,
                                           byte[] body,
                                           ServerRequest req,
                                           ServerResponse res,
                                           Long timeoutMs) {
        MethodDescriptor<ReqT, RespT> descriptor = method.getMethodDescriptor();

        ReqT request;
        try {
            request = parseRequest(descriptor, codec, body);
        } catch (Exception e) {
            sendError(res, ConnectCode.INVALID_ARGUMENT,
                    "failed to decode " + codec.name().toLowerCase(Locale.ROOT) + " request message: "
                            + e.getMessage(),
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
            outcome = timeoutMs == null
                    ? call.outcome().get()
                    : call.outcome().get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            call.cancel();
            notifyCancel(listener);
            sendError(res, ConnectCode.DEADLINE_EXCEEDED,
                    "the operation timed out after " + timeoutMs + "ms (connect-timeout-ms)", null);
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
            if (outcome.headers() != null) {
                errorMetadata.merge(outcome.headers());
            }
            if (outcome.trailers() != null) {
                errorMetadata.merge(outcome.trailers());
            }
            sendError(res, code, outcome.status().getDescription(), errorMetadata);
            return;
        }

        if (outcome.message() == null) {
            sendError(res, ConnectCode.INTERNAL, "unary call closed without a response message", null);
            return;
        }

        byte[] responseBody;
        try {
            responseBody = serializeResponse(descriptor, codec, outcome.message());
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
    private Codec negotiateCodec(ServerRequest req, ServerMethodDefinition<?, ?> method) {
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

    private static boolean supportsJson(MethodDescriptor<?, ?> descriptor) {
        return messagePrototype(descriptor.getRequestMarshaller()) != null
                && messagePrototype(descriptor.getResponseMarshaller()) != null;
    }

    private static Message messagePrototype(MethodDescriptor.Marshaller<?> marshaller) {
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
        Message prototype = messagePrototype(descriptor.getRequestMarshaller());
        Message.Builder builder = prototype.newBuilderForType();
        JsonFormat.parser().ignoringUnknownFields().merge(new String(body, StandardCharsets.UTF_8), builder);
        return (ReqT) builder.build();
    }

    private static <RespT> byte[] serializeResponse(MethodDescriptor<?, RespT> descriptor, Codec codec,
                                                    RespT message) throws Exception {
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
    private static Long parseTimeoutMs(Optional<String> header) {
        if (header.isEmpty()) {
            return null;
        }
        String value = header.get().trim();
        if (value.isEmpty() || value.length() > MAX_TIMEOUT_DIGITS || !value.chars().allMatch(Character::isDigit)) {
            throw new IllegalArgumentException("protocol error: invalid connect-timeout-ms value \"" + value + "\"");
        }
        return Long.parseLong(value);
    }

    private static void sendError(ServerResponse res, ConnectCode code, String message, Metadata metadata) {
        sendError(res, code.httpStatus(), code, message, metadata);
    }

    private static void sendError(ServerResponse res, int httpStatus, ConnectCode code, String message,
                                  Metadata metadata) {
        if (metadata != null) {
            HttpMetadata.writeToResponse(res, metadata, "");
        }
        res.header(CONTENT_TYPE, CONTENT_TYPE_JSON);
        res.status(io.helidon.http.Status.create(httpStatus))
                .send(ConnectErrorJson.toJson(code, message).getBytes(StandardCharsets.UTF_8));
    }

    private static void notifyCancel(ServerCall.Listener<?> listener) {
        if (listener == null) {
            return;
        }
        try {
            listener.onCancel();
        } catch (RuntimeException e) {
            // The response is already decided; listener cleanup failures are not actionable.
        }
    }

    private static void notifyComplete(ServerCall.Listener<?> listener) {
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
