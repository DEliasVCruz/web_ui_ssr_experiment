import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { callUnaryMethod, createConnectQueryKey } from "@connectrpc/connect-query-core";
import {
	createTodo as createTodoMethod,
	deleteTodo as deleteTodoMethod,
	getTodo,
	listTodos,
	updateTodo as updateTodoMethod,
} from "@web-ui-poc/rpc/gen/todo/v1/todo-TodoService_connectquery";

/**
 * Protobuf Timestamps carry `seconds` as bigint; the UI (formatDate) works with
 * numbers. Normalise inside the queryFn so the query cache — and its dehydrated
 * SSR payload — holds numbers consistently for both the list and detail queries.
 */
function toNumberTimestamp(ts: { seconds: bigint } | undefined): { seconds: number } | undefined {
	if (!ts) return undefined;
	return { seconds: Number(ts.seconds) };
}

export function todosQueryOptions(transport: Transport) {
	return {
		// Same key the mutations invalidate with, so writes refresh the list.
		queryKey: createConnectQueryKey({ schema: listTodos, transport, cardinality: undefined }),
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
		mutationFn: async (vars: { id: string; title?: string; completed?: boolean }) => {
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
		queryKey: createConnectQueryKey({
			schema: getTodo,
			input: { id },
			transport,
			cardinality: "finite",
		}),
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
