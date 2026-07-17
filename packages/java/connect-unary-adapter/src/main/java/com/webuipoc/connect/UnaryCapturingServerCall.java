package com.webuipoc.connect;

import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.Status;
import java.util.concurrent.CompletableFuture;
import org.jspecify.annotations.Nullable;

/**
 * A {@link ServerCall} that never touches a gRPC transport: it captures what a
 * unary {@code ServerCallHandler} (typically built with
 * {@code io.grpc.stub.ServerCalls}) writes to the call, and exposes the final
 * result as a {@link CompletableFuture}. This is what lets the adapter invoke
 * any {@code ServerServiceDefinition}'s method handlers in-process, without
 * knowing anything about the concrete service.
 */
final class UnaryCapturingServerCall<ReqT, RespT> extends ServerCall<ReqT, RespT> {

    /** Terminal state of the call: {@code close(status, trailers)} plus what was sent before it. */
    record Outcome<T>(
            Status status,
            @Nullable Metadata headers,
            @Nullable T message,
            Metadata trailers) {}

    private final MethodDescriptor<ReqT, RespT> method;
    private final CompletableFuture<Outcome<RespT>> outcome = new CompletableFuture<>();
    // headers/message are captured lazily as the handler writes to the call; both
    // are null until (and unless) sendHeaders/sendMessage run.
    private volatile @Nullable Metadata headers;
    private volatile @Nullable RespT message;
    private volatile boolean cancelled;

    UnaryCapturingServerCall(MethodDescriptor<ReqT, RespT> method) {
        this.method = method;
    }

    @Override
    public void request(int numMessages) {
        // No transport flow control: the adapter pushes exactly one message.
    }

    @Override
    public void sendHeaders(Metadata headers) {
        this.headers = headers;
    }

    @Override
    public void sendMessage(RespT message) {
        if (this.message == null) {
            this.message = message;
        }
    }

    @Override
    public void close(Status status, Metadata trailers) {
        outcome.complete(new Outcome<>(status, headers, message, trailers));
    }

    @Override
    public boolean isCancelled() {
        return cancelled;
    }

    @Override
    public MethodDescriptor<ReqT, RespT> getMethodDescriptor() {
        return method;
    }

    CompletableFuture<Outcome<RespT>> outcome() {
        return outcome;
    }

    /** Marks the call cancelled (deadline enforcement); late writes become no-ops. */
    void cancel() {
        cancelled = true;
    }

    /**
     * Completes the outcome with {@code status} if the handler failed before
     * calling {@link #close(Status, Metadata)} (e.g. the implementation threw
     * from {@code onHalfClose}). No-op if the call already closed.
     */
    void failIfPending(Status status, @Nullable Metadata trailers) {
        outcome.complete(new Outcome<>(status, headers, null, trailers == null ? new Metadata() : trailers));
    }
}
