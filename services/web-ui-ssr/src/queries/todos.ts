import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { callUnaryMethod, createConnectQueryKey } from "@connectrpc/connect-query-core";
import type { QueryClient } from "@tanstack/solid-query";
import type { Todo } from "@web-ui-poc/rpc/gen/todo/v1/todo_pb";
import {
	createTodo as createTodoMethod,
	deleteTodo as deleteTodoMethod,
	getTodo,
	listTodos,
	updateTodo as updateTodoMethod,
} from "@web-ui-poc/rpc/gen/todo/v1/todo-TodoService_connectquery";
import { type CapturedActionContext, runActionWithContext } from "../observability/browser-events";

// Stable mutation keys (task 1w9.4). Every offline-capable mutation is KEYED so
// (a) its paused state can be dehydrated to IndexedDB and rehydrated, and (b) a
// rehydrated mutation resolves its `mutationFn` + reconciliation handlers from
// `setMutationDefaults(key, …)` (see src/queue/mutation-defaults.ts) even though
// the component that created it isn't mounted. Toggle and edit are both
// UpdateTodo but get DISTINCT keys: they are different user actions and the list
// reads pending toggles by key via useMutationState.
export const CREATE_TODO_KEY = ["createTodo"] as const;
export const TOGGLE_TODO_KEY = ["toggleTodo"] as const;
export const EDIT_TODO_KEY = ["editTodoDetails"] as const;
export const DELETE_TODO_KEY = ["deleteTodo"] as const;

// Mutation variables carry the enqueue-time trace context as `__trace` (task
// 1w9.4 §4.4): captured when the user acts, PERSISTED with the paused mutation,
// and replayed via runActionWithContext so a queued RPC reuses the original
// trace_id. `create` also carries the client-minted `id` (§4.1) so the optimistic
// row is final from the first onMutate and replay is byte-identical.
export interface CreateTodoVars {
	readonly id: string;
	readonly title: string;
	readonly __trace: CapturedActionContext;
}
export interface UpdateTodoVars {
	readonly id: string;
	readonly title?: string;
	readonly completed?: boolean;
	readonly details?: string;
	readonly __trace: CapturedActionContext;
}
export interface DeleteTodoVars {
	readonly id: string;
	readonly __trace: CapturedActionContext;
}

function isOffline(): boolean {
	return typeof navigator !== "undefined" && !navigator.onLine;
}

/**
 * The a4a.3 keep-pending-until-refetch invalidation, OFFLINE-GUARDED (1w9.4
 * design §4.5). Online it RETURNS the invalidation promise so query-core holds
 * the mutation `pending` until the refreshed server truth lands (the a4a.3
 * no-bounce / no-vanish guarantee). Offline it fires the invalidation but returns
 * `undefined`, so a mutation that happens to settle while disconnected is never
 * wedged `pending` forever on a refetch that cannot complete.
 */
export function settleInvalidate(
	queryClient: QueryClient,
	keys: readonly (readonly unknown[])[],
): Promise<unknown> | undefined {
	const invalidation = Promise.all(
		keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
	);
	if (isOffline()) {
		void invalidation;
		return undefined;
	}
	return invalidation;
}

/**
 * The shape the query cache actually holds for a todo: the generated `Todo` but
 * with the protobuf Timestamps normalised to `{ seconds: number }` (see
 * `toNumberTimestamp`). This is what `todosQueryOptions`/`todoQueryOptions`
 * return, and therefore what optimistic cache writers (edit/delete) must read
 * and write. NB: `details` is typed non-optional by the generated `Todo`, but the
 * `{...todo}` spread in the queryFns drops the unset explicit-presence field, so
 * a never-set todo carries `details: undefined` at runtime (a4a.1 field guide #2)
 * — hence the honest `?` here.
 */
export type CachedTodo = Omit<Todo, "createdAt" | "updatedAt" | "details"> & {
	// Each optional field is genuinely present-with-`undefined` at runtime (the
	// queryFn always assigns `toNumberTimestamp(...)`, which can be undefined; and
	// the `{...todo}` spread yields `details: undefined` for a never-set todo), so
	// the unions include `undefined` explicitly — required under
	// exactOptionalPropertyTypes, and honest about the runtime shape.
	createdAt?: { seconds: number } | undefined;
	updatedAt?: { seconds: number } | undefined;
	details?: string | undefined;
};

/**
 * Protobuf Timestamps carry `seconds` as bigint; the UI (formatDate) works with
 * numbers. Normalise inside the queryFn so the query cache — and its dehydrated
 * SSR payload — holds numbers consistently for both the list and detail queries.
 */
function toNumberTimestamp(ts: { seconds: bigint } | undefined): { seconds: number } | undefined {
	if (!ts) return undefined;
	return { seconds: Number(ts.seconds) };
}

/**
 * The single list-query key. Shared by the list query and by every mutation that
 * snapshots / writes / invalidates the list optimistically, so they all address
 * the exact same cache entry. `cardinality: undefined` matches ListTodos (no
 * input) — same as `todosQueryOptions`.
 */
export function listTodosQueryKey(transport: Transport) {
	return createConnectQueryKey({ schema: listTodos, transport, cardinality: undefined });
}

/** The per-id detail-query key, shared by the detail query and its mutations. */
export function todoQueryKey(transport: Transport, id: string) {
	return createConnectQueryKey({
		schema: getTodo,
		input: { id },
		transport,
		cardinality: "finite",
	});
}

export function todosQueryOptions(transport: Transport) {
	return {
		// Same key the mutations invalidate with, so writes refresh the list.
		queryKey: listTodosQueryKey(transport),
		queryFn: async () => {
			const response = await callUnaryMethod(transport, listTodos, {});
			return response.todos.map((todo) => ({
				...todo,
				createdAt: toNumberTimestamp(todo.createdAt),
				updatedAt: toNumberTimestamp(todo.updatedAt),
			}));
		},
	} as const;
}

export function createTodoMutation(transport: Transport) {
	return {
		// Replayed under the ENQUEUE-time trace (task 1w9.4 §4.4): one trace per
		// create — captured at mutate(), carried in `__trace`, reused here whether
		// the RPC flies live or is flushed from the queue — its RPC carrying a child
		// `traceparent` and emitting exactly one browser wide event when it flies.
		// The client-minted `id` is sent verbatim (never `""`, which is a guaranteed
		// 400): the backend echoes it (idempotent first-write-wins). Reconcile from
		// the RESPONSE todo — first-write-wins may return a pre-existing row.
		mutationFn: (vars: CreateTodoVars) =>
			runActionWithContext(vars.__trace, async () => {
				const response = await callUnaryMethod(transport, createTodoMethod, {
					id: vars.id,
					title: vars.title,
				});
				return response.todo;
			}),
	};
}

// UpdateTodo backs two distinct user actions — a list-row completion TOGGLE and a
// details EDIT — distinguished by the captured `__trace.action` label (task
// iq2.4) and by their distinct mutation keys.
export function updateTodoMutation(transport: Transport) {
	return {
		// `details` is threaded through explicit-presence semantics: OMIT the key
		// (undefined) to leave stored details unchanged; pass `""` to deliberately
		// CLEAR them; pass text to set them. Callers MUST construct these vars
		// explicitly and include `details` ONLY when the user edited it — never
		// spread a cached todo in, whose inherited `details: ""` would silently
		// clear stored content. See a4a.1 field guide #2.
		mutationFn: (vars: UpdateTodoVars) =>
			runActionWithContext(vars.__trace, async () => {
				// Strip the transport-only `__trace` before it hits the wire (leading
				// underscore ⇒ intentionally unused local).
				const { __trace, ...request } = vars;
				const response = await callUnaryMethod(transport, updateTodoMethod, request);
				return response.todo;
			}),
	};
}

export function deleteTodoMutation(transport: Transport) {
	return {
		mutationFn: (vars: DeleteTodoVars) =>
			runActionWithContext(vars.__trace, async () => {
				await callUnaryMethod(transport, deleteTodoMethod, { id: vars.id });
			}),
	};
}

export function todoQueryOptions(transport: Transport, id: string) {
	return {
		queryKey: todoQueryKey(transport, id),
		queryFn: async () => {
			try {
				const response = await callUnaryMethod(transport, getTodo, { id });
				const todo = response.todo;
				if (!todo) return null;
				return {
					...todo,
					createdAt: toNumberTimestamp(todo.createdAt),
					updatedAt: toNumberTimestamp(todo.updatedAt),
				};
			} catch (err) {
				if (err instanceof ConnectError && err.code === Code.NotFound) {
					return null;
				}
				throw err;
			}
		},
	} as const;
}
