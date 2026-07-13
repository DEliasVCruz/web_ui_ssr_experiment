package com.webuipoc.businesslogic.connect;

import io.grpc.Status;
import java.util.EnumMap;
import java.util.Map;

/**
 * Connect protocol error codes and their HTTP status mapping for unary RPCs.
 *
 * <p>This is a verbatim transcription of the "Error Codes" table of the Connect
 * protocol specification (https://connectrpc.com/docs/protocol/), cross-checked
 * against connect-es 2.1.2 ({@code protocol-connect/http-status.js},
 * {@code codeToHttpStatus}):
 *
 * <pre>
 * canceled             499  Client Closed Request
 * unknown              500  Internal Server Error
 * invalid_argument     400  Bad Request
 * deadline_exceeded    504  Gateway Timeout
 * not_found            404  Not Found
 * already_exists       409  Conflict
 * permission_denied    403  Forbidden
 * resource_exhausted   429  Too Many Requests
 * failed_precondition  400  Bad Request
 * aborted              409  Conflict
 * out_of_range         400  Bad Request
 * unimplemented        501  Not Implemented
 * internal             500  Internal Server Error
 * unavailable          503  Service Unavailable
 * data_loss            500  Internal Server Error
 * unauthenticated      401  Unauthorized
 * </pre>
 */
public enum ConnectCode {
    CANCELED(Status.Code.CANCELLED, "canceled", 499),
    UNKNOWN(Status.Code.UNKNOWN, "unknown", 500),
    INVALID_ARGUMENT(Status.Code.INVALID_ARGUMENT, "invalid_argument", 400),
    DEADLINE_EXCEEDED(Status.Code.DEADLINE_EXCEEDED, "deadline_exceeded", 504),
    NOT_FOUND(Status.Code.NOT_FOUND, "not_found", 404),
    ALREADY_EXISTS(Status.Code.ALREADY_EXISTS, "already_exists", 409),
    PERMISSION_DENIED(Status.Code.PERMISSION_DENIED, "permission_denied", 403),
    RESOURCE_EXHAUSTED(Status.Code.RESOURCE_EXHAUSTED, "resource_exhausted", 429),
    FAILED_PRECONDITION(Status.Code.FAILED_PRECONDITION, "failed_precondition", 400),
    ABORTED(Status.Code.ABORTED, "aborted", 409),
    OUT_OF_RANGE(Status.Code.OUT_OF_RANGE, "out_of_range", 400),
    UNIMPLEMENTED(Status.Code.UNIMPLEMENTED, "unimplemented", 501),
    INTERNAL(Status.Code.INTERNAL, "internal", 500),
    UNAVAILABLE(Status.Code.UNAVAILABLE, "unavailable", 503),
    DATA_LOSS(Status.Code.DATA_LOSS, "data_loss", 500),
    UNAUTHENTICATED(Status.Code.UNAUTHENTICATED, "unauthenticated", 401);

    private static final Map<Status.Code, ConnectCode> BY_GRPC_CODE = new EnumMap<>(Status.Code.class);

    static {
        for (ConnectCode code : values()) {
            BY_GRPC_CODE.put(code.grpcCode, code);
        }
    }

    private final Status.Code grpcCode;
    private final String wireCode;
    private final int httpStatus;

    ConnectCode(Status.Code grpcCode, String wireCode, int httpStatus) {
        this.grpcCode = grpcCode;
        this.wireCode = wireCode;
        this.httpStatus = httpStatus;
    }

    /**
     * Maps a gRPC status code to the Connect code. {@link Status.Code#OK} is not
     * an error and has no Connect representation; per the spec's guidance for
     * missing/malformed codes it degrades to {@link #UNKNOWN}.
     */
    public static ConnectCode fromGrpc(Status.Code code) {
        ConnectCode connectCode = BY_GRPC_CODE.get(code);
        return connectCode == null ? UNKNOWN : connectCode;
    }

    /** The gRPC status code this Connect code corresponds to. */
    public Status.Code grpcCode() {
        return grpcCode;
    }

    /** The string sent in the JSON error body, e.g. {@code "not_found"}. */
    public String wireCode() {
        return wireCode;
    }

    /** The HTTP response status for a unary error with this code. */
    public int httpStatus() {
        return httpStatus;
    }
}
