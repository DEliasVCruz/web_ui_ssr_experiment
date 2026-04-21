import { createClient, type Transport } from "@connectrpc/connect";
import type { QueryClient } from "@tanstack/solid-query";
import { TodoService } from "@web-ui-poc/rpc/gen/proto/todo/v1/todo_pb";

export const todosQueryKey = ["todos"] as const;

export function todosQueryOptions(transport: Transport) {
	return {
		queryKey: todosQueryKey,
		queryFn: async () => {
			const client = createClient(TodoService, transport);
			const response = await client.listTodos({});
			return response.todos;
		},
	} as const;
}

export async function prefetchTodos(queryClient: QueryClient, transport: Transport) {
	await queryClient.prefetchQuery(todosQueryOptions(transport));
}
