package com.webuipoc.businesslogic.connect;

/**
 * Serializes Connect unary error bodies.
 *
 * <p>Per the Connect protocol, a unary error response carries a non-200 HTTP
 * status and a JSON body of the shape {@code {"code": "...", "message": "..."}}
 * — always JSON, regardless of the codec used by the request. {@code message}
 * is optional and omitted when the underlying status has no description.
 *
 * <p>Error details ({@code "details"}) are not emitted: {@code io.grpc.Status}
 * carries no detail messages, and this adapter does not unpack
 * {@code grpc-status-details-bin} trailers.
 */
final class ConnectErrorJson {

    private ConnectErrorJson() {
    }

    static String toJson(ConnectCode code, String message) {
        StringBuilder json = new StringBuilder("{\"code\":\"").append(code.wireCode()).append('"');
        if (message != null && !message.isEmpty()) {
            json.append(",\"message\":\"");
            escapeInto(json, message);
            json.append('"');
        }
        return json.append('}').toString();
    }

    private static void escapeInto(StringBuilder out, String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
    }
}
