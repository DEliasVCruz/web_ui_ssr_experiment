import { type Client, createClient, type Transport } from "@connectrpc/connect";
import type { QueryClient } from "@tanstack/solid-query";
import { TodoService } from "@web-ui-poc/rpc/gen/proto/todo/v1/todo_pb";

export const todosQueryKey = ["todos"] as const;

function todoClient(transport: Transport): Client<typeof TodoService> {
	return createClient(TodoService, transport);
}

export function todosQueryOptions(transport: Transport) {
	return {
		queryKey: todosQueryKey,
		queryFn: async () => {
			const response = await todoClient(transport).listTodos({});
			return response.todos;
		},
	} as const;
}

export async function prefetchTodos(queryClient: QueryClient, transport: Transport) {
	await queryClient.prefetchQuery(todosQueryOptions(transport));
}

export function createTodoMutation(transport: Transport) {
	return {
		mutationFn: async (title: string) => {
			const response = await todoClient(transport).createTodo({ title });
			return response.todo;
		},
	};
}

export function updateTodoMutation(transport: Transport) {
	return {
		mutationFn: async (vars: { id: string; title?: string; completed?: boolean }) => {
			const response = await todoClient(transport).updateTodo(vars);
			return response.todo;
		},
	};
}

export function deleteTodoMutation(transport: Transport) {
	return {
		mutationFn: async (id: string) => {
			await todoClient(transport).deleteTodo({ id });
		},
	};
}

export const todoQueryKey = (id: string) => ["todo", id] as const;

export function todoQueryOptions(transport: Transport, id: string) {
	return {
		queryKey: todoQueryKey(id),
		queryFn: async () => {
			const response = await todoClient(transport).getTodo({ id });
			return response.todo;
		},
	} as const;
}

export async function prefetchTodo(queryClient: QueryClient, transport: Transport, id: string) {
	await queryClient.prefetchQuery(todoQueryOptions(transport, id));
}
