import { createConnectQueryKey } from "@connectrpc/connect-query-core";
import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute, Link } from "@tanstack/solid-router";
import { getTodo, listTodos } from "@web-ui-poc/rpc/gen/todo/v1/todo-TodoService_connectquery";
import { createSignal, For, Show, Suspense } from "solid-js";
import { container } from "../pages/shared.styles";
import {
	addButton,
	addForm,
	addInput,
	checkbox,
	deleteButton,
	emptyState,
	errorMessage,
	heading,
	item,
	list,
	timestamp,
	titleCompleted,
	titleText,
} from "../pages/todos.styles";
import {
	createTodoMutation,
	deleteTodoMutation,
	todosQueryOptions,
	updateTodoMutation,
} from "../queries/todos";
import { useTransport } from "../transport-context";

const MS_PER_SECOND = 1000;

function formatDate(ts: { seconds: number } | undefined): string {
	if (!ts) return "";
	return new Date(ts.seconds * MS_PER_SECOND).toLocaleDateString();
}

function AddTodoForm() {
	const transport = useTransport();
	const queryClient = useQueryClient();
	const [title, setTitle] = createSignal("");

	const create = createMutation(() => ({
		...createTodoMutation(transport),
		onSuccess: () => {
			setTitle("");
			void queryClient.invalidateQueries({
				queryKey: createConnectQueryKey({ schema: listTodos, transport, cardinality: undefined }),
			});
		},
	}));

	const handleSubmit = (e: SubmitEvent) => {
		e.preventDefault();
		const value = title().trim();
		if (value) {
			create.mutate(value);
		}
	};

	return (
		<form class={addForm} onSubmit={handleSubmit}>
			<input
				class={addInput}
				type="text"
				placeholder="What needs to be done?"
				value={title()}
				onInput={(e) => setTitle(e.currentTarget.value)}
				disabled={create.isPending}
			/>
			<button class={addButton} type="submit" disabled={create.isPending || !title().trim()}>
				Add
			</button>
			<Show when={create.isError}>
				<p class={errorMessage}>Failed to add todo. Please try again.</p>
			</Show>
		</form>
	);
}

function TodoList() {
	const transport = useTransport();
	const queryClient = useQueryClient();
	const query = createQuery(() => todosQueryOptions(transport));

	const update = createMutation(() => ({
		...updateTodoMutation(transport),
		onSuccess: (_data, vars) => {
			void queryClient.invalidateQueries({
				queryKey: createConnectQueryKey({ schema: listTodos, transport, cardinality: undefined }),
			});
			void queryClient.invalidateQueries({
				queryKey: createConnectQueryKey({
					schema: getTodo,
					input: { id: vars.id },
					transport,
					cardinality: "finite",
				}),
			});
		},
	}));

	const remove = createMutation(() => ({
		...deleteTodoMutation(transport),
		onSuccess: (_data, id) => {
			void queryClient.invalidateQueries({
				queryKey: createConnectQueryKey({ schema: listTodos, transport, cardinality: undefined }),
			});
			queryClient.removeQueries({
				queryKey: createConnectQueryKey({
					schema: getTodo,
					input: { id },
					transport,
					cardinality: "finite",
				}),
			});
		},
	}));

	return (
		<Show when={!query.error} fallback={<p class={emptyState}>Failed to load todos.</p>}>
			<Show when={update.isError || remove.isError}>
				<p class={errorMessage}>
					{update.isError ? "Failed to update todo." : "Failed to delete todo."} Please try again.
				</p>
			</Show>
			<Show when={query.data?.length} fallback={<p class={emptyState}>No todos yet.</p>}>
				<ul class={list}>
					<For each={query.data}>
						{(todo) => (
							<li class={item}>
								<input
									type="checkbox"
									class={checkbox}
									checked={todo.completed}
									onChange={() => {
										update.mutate({ id: todo.id, completed: !todo.completed });
									}}
									disabled={update.isPending && update.variables.id === todo.id}
								/>
								<Link
									to="/todos/$id"
									params={{ id: todo.id }}
									class={todo.completed ? titleCompleted : titleText}
								>
									{todo.title}
								</Link>
								<span class={timestamp}>{formatDate(todo.createdAt)}</span>
								<button
									type="button"
									class={deleteButton}
									onClick={() => {
										remove.mutate(todo.id);
									}}
									disabled={remove.isPending && remove.variables === todo.id}
								>
									Delete
								</button>
							</li>
						)}
					</For>
				</ul>
			</Show>
		</Show>
	);
}

export const Route = createFileRoute("/todos/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(todosQueryOptions(context.transport)),
	head: () => ({
		meta: [{ title: "Todos | Web UI SSR" }, { name: "description", content: "TODO list" }],
	}),
	component: () => (
		<div class={container}>
			<h1 class={heading}>Todos</h1>
			<AddTodoForm />
			<Suspense fallback={<p>Loading todos...</p>}>
				<TodoList />
			</Suspense>
		</div>
	),
});
