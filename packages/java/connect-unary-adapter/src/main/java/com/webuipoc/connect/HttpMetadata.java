package com.webuipoc.connect;

import io.grpc.Metadata;
import io.helidon.http.Header;
import io.helidon.http.HeaderNames;
import io.helidon.http.Headers;
import io.helidon.webserver.http.ServerResponse;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Converts between HTTP headers and {@link io.grpc.Metadata} following the
 * Connect unary conventions: ASCII metadata maps 1:1 to header fields, binary
 * metadata (keys ending in {@code -bin}) is base64 encoded (unpadded on the
 * way out, padding-tolerant on the way in), and on successful responses
 * trailing metadata is sent as headers prefixed with {@code trailer-}.
 */
final class HttpMetadata {

    /**
     * Request headers that carry Connect/HTTP protocol semantics and must not
     * leak into the application {@link Metadata} handed to the service.
     */
    private static final Set<String> PROTOCOL_REQUEST_HEADERS = Set.of(
            "content-type",
            "content-length",
            "content-encoding",
            "accept-encoding",
            "connect-protocol-version",
            "connect-timeout-ms",
            "connect-content-encoding",
            "connect-accept-encoding",
            "host",
            "connection",
            "keep-alive",
            "proxy-connection",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade");

    /** Response headers owned by the adapter; metadata must not override them. */
    private static final Set<String> RESERVED_RESPONSE_HEADERS = Set.of(
            "content-type",
            "content-length",
            "content-encoding",
            "transfer-encoding");

    private HttpMetadata() {
    }

    static Metadata fromRequestHeaders(Headers headers) {
        Metadata metadata = new Metadata();
        for (Header header : headers) {
            String name = header.name().toLowerCase(Locale.ROOT);
            if (PROTOCOL_REQUEST_HEADERS.contains(name)) {
                continue;
            }
            if (name.endsWith(Metadata.BINARY_HEADER_SUFFIX)) {
                Metadata.Key<byte[]> key = Metadata.Key.of(name, Metadata.BINARY_BYTE_MARSHALLER);
                for (String value : header.allValues()) {
                    metadata.put(key, decodeBase64Lenient(value));
                }
            } else {
                Metadata.Key<String> key = Metadata.Key.of(name, Metadata.ASCII_STRING_MARSHALLER);
                for (String value : header.allValues()) {
                    metadata.put(key, value);
                }
            }
        }
        return metadata;
    }

    /**
     * Writes {@code metadata} onto the response, each header name prefixed with
     * {@code prefix} ({@code ""} for leading metadata and error metadata,
     * {@code "trailer-"} for trailing metadata of successful responses).
     */
    static void writeToResponse(ServerResponse res, Metadata metadata, String prefix) {
        if (metadata == null) {
            return;
        }
        for (String name : metadata.keys()) {
            if (RESERVED_RESPONSE_HEADERS.contains(name) || name.startsWith(":")) {
                continue;
            }
            List<String> values = new ArrayList<>();
            if (name.endsWith(Metadata.BINARY_HEADER_SUFFIX)) {
                Iterable<byte[]> all = metadata.getAll(Metadata.Key.of(name, Metadata.BINARY_BYTE_MARSHALLER));
                if (all != null) {
                    for (byte[] value : all) {
                        values.add(Base64.getEncoder().withoutPadding().encodeToString(value));
                    }
                }
            } else {
                Iterable<String> all = metadata.getAll(Metadata.Key.of(name, Metadata.ASCII_STRING_MARSHALLER));
                if (all != null) {
                    for (String value : all) {
                        values.add(value);
                    }
                }
            }
            if (!values.isEmpty()) {
                res.header(HeaderNames.create(prefix + name), values.toArray(String[]::new));
            }
        }
    }

    private static byte[] decodeBase64Lenient(String value) {
        String padded = switch (value.length() % 4) {
            case 2 -> value + "==";
            case 3 -> value + "=";
            default -> value;
        };
        return Base64.getDecoder().decode(padded);
    }
}
