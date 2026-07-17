package com.webuipoc.businesslogic.domain;

/**
 * Thrown by the domain {@code TodoService} when an operation targets a todo that
 * does not exist. The gRPC bridge maps it to {@code io.grpc.Status.NOT_FOUND};
 * the message is preserved on the wire (the Bun service used {@code "todo not
 * found"}).
 */
public class NotFoundException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public NotFoundException(String message) {
        super(message);
    }
}
