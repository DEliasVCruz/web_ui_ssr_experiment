import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
	callUnaryMethod,
	createConnectQueryKey,
	createQueryOptions,
} from "@connectrpc/connect-query-core";
import type { ListTodosResponse } from "@web-ui-poc/rpc/gen/todo/v1/todo_pb";
import {
	createTodo as createTodoMethod,
	deleteTodo as deleteTodoMethod,
	getTodo,
	listTodos,
	updateTodo as updateTodoMethod,
} from "@web-ui-poc/rpc/gen/todo/v1/todo-TodoService_connectquery";

/** Convert BigInt timestamp seconds to number so TanStack Router SSR serialization works. */
function toNumberTimestamp(ts: { seconds: bigint } | undefined): { seconds: number } | undefined {
	if (!ts) return undefined;
	return { seconds: Number(ts.seconds) };
}

export function todosQueryOptions(transport: Transport) {
	return {
		...createQueryOptions(listTodos, {}, { transport }),
		select: (data: ListTodosResponse) =>
			data.todos.map((todo) => ({
				...todo,
				createdAt: toNumberTimestamp(todo.createdAt),
				updatedAt: toNumberTimestamp(todo.updatedAt),
			})),
	};
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
