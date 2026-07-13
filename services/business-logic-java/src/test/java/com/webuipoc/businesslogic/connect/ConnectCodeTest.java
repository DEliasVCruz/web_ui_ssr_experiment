package com.webuipoc.businesslogic.connect;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.grpc.Status;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Unit test for the error-code table, transcribed independently from
 * https://connectrpc.com/docs/protocol/ ("Error Codes") so a typo in
 * {@link ConnectCode} cannot silently self-verify.
 */
class ConnectCodeTest {

    private record Expectation(String wireCode, int httpStatus) {
    }

    private static final Map<Status.Code, Expectation> SPEC_TABLE = Map.ofEntries(
            Map.entry(Status.Code.CANCELLED, new Expectation("canceled", 499)),
            Map.entry(Status.Code.UNKNOWN, new Expectation("unknown", 500)),
            Map.entry(Status.Code.INVALID_ARGUMENT, new Expectation("invalid_argument", 400)),
            Map.entry(Status.Code.DEADLINE_EXCEEDED, new Expectation("deadline_exceeded", 504)),
            Map.entry(Status.Code.NOT_FOUND, new Expectation("not_found", 404)),
            Map.entry(Status.Code.ALREADY_EXISTS, new Expectation("already_exists", 409)),
            Map.entry(Status.Code.PERMISSION_DENIED, new Expectation("permission_denied", 403)),
            Map.entry(Status.Code.RESOURCE_EXHAUSTED, new Expectation("resource_exhausted", 429)),
            Map.entry(Status.Code.FAILED_PRECONDITION, new Expectation("failed_precondition", 400)),
            Map.entry(Status.Code.ABORTED, new Expectation("aborted", 409)),
            Map.entry(Status.Code.OUT_OF_RANGE, new Expectation("out_of_range", 400)),
            Map.entry(Status.Code.UNIMPLEMENTED, new Expectation("unimplemented", 501)),
            Map.entry(Status.Code.INTERNAL, new Expectation("internal", 500)),
            Map.entry(Status.Code.UNAVAILABLE, new Expectation("unavailable", 503)),
            Map.entry(Status.Code.DATA_LOSS, new Expectation("data_loss", 500)),
            Map.entry(Status.Code.UNAUTHENTICATED, new Expectation("unauthenticated", 401)));

    @Test
    void everyErrorCodeMatchesTheSpecTable() {
        assertEquals(16, SPEC_TABLE.size());
        assertEquals(16, ConnectCode.values().length);
        for (Map.Entry<Status.Code, Expectation> entry : SPEC_TABLE.entrySet()) {
            ConnectCode code = ConnectCode.fromGrpc(entry.getKey());
            assertEquals(entry.getKey(), code.grpcCode());
            assertEquals(entry.getValue().wireCode(), code.wireCode(), "wire code for " + entry.getKey());
            assertEquals(entry.getValue().httpStatus(), code.httpStatus(), "http status for " + entry.getKey());
        }
    }

    @Test
    void okHasNoConnectCodeAndDegradesToUnknown() {
        assertEquals(ConnectCode.UNKNOWN, ConnectCode.fromGrpc(Status.Code.OK));
    }
}
