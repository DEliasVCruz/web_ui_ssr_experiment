import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { callUnaryMethod, createConnectQueryKey } from "@connectrpc/connect-query-core";
import type { Todo } from "@web-ui-poc/rpc/gen/todo/v1/todo_pb";
import {
	createTodo as createTodoMethod,
	deleteTodo as deleteTodoMethod,
	getTodo,
	listTodos,
	updateTodo as updateTodoMethod,
} from "@web-ui-poc/rpc/gen/todo/v1/todo-TodoService_connectquery";

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
		mutationFn: async (title: string) => {
			const response = await callUnaryMethod(transport, createTodoMethod, { title });
			return response.todo;
		},
	};
}

export function updateTodoMutation(transport: Transport) {
	return {
		// `details` is threaded through explicit-presence semantics: OMIT the key
		// (undefined) to leave stored details unchanged; pass `""` to deliberately
		// CLEAR them; pass text to set them. Callers MUST construct these vars
		// explicitly and include `details` ONLY when the user edited it — never
		// spread a cached todo in, whose inherited `details: ""` would silently
		// clear stored content. See a4a.1 field guide #2.
		mutationFn: async (vars: {
			id: string;
			title?: string;
			completed?: boolean;
			details?: string;
		}) => {
			const response = await callUnaryMethod(transport, updateTodoMethod, vars);
			return response.todo;
		},
	};
}

export function deleteTodoMutation(transport: Transport) {
	return {
		mutationFn: async (id: string) => {
			await callUnaryMethod(transport, deleteTodoMethod, { id });
		},
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
