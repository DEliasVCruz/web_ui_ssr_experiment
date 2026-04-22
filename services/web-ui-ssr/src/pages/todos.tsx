import { Meta, Title } from "@solidjs/meta";
import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query";
import { createSignal, For, Show, Suspense } from "solid-js";
import {
	createTodoMutation,
	deleteTodoMutation,
	todosQueryKey,
	todosQueryOptions,
	updateTodoMutation,
} from "../queries/todos";
import { getClientTransport } from "../transport-client";
import { container } from "./shared.css";
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
} from "./todos.css";

const MS_PER_SECOND = 1000;

function formatDate(ts: { seconds: bigint } | undefined): string {
	if (!ts) return "";
	return new Date(Number(ts.seconds) * MS_PER_SECOND).toLocaleDateString();
}

function AddTodoForm() {
	const transport = getClientTransport();
	const queryClient = useQueryClient();
	const [title, setTitle] = createSignal("");

	const create = createMutation(() => ({
		...createTodoMutation(transport),
		onSuccess: () => {
			setTitle("");
			queryClient.invalidateQueries({ queryKey: [...todosQueryKey] });
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
	const transport = getClientTransport();
	const queryClient = useQueryClient();
	const query = createQuery(() => todosQueryOptions(transport));

	const update = createMutation(() => ({
		...updateTodoMutation(transport),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [...todosQueryKey] });
		},
	}));

	const remove = createMutation(() => ({
		...deleteTodoMutation(transport),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [...todosQueryKey] });
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
									onChange={() => update.mutate({ id: todo.id, completed: !todo.completed })}
									disabled={update.isPending && update.variables?.id === todo.id}
								/>
								<span class={todo.completed ? titleCompleted : titleText}>{todo.title}</span>
								<span class={timestamp}>{formatDate(todo.createdAt)}</span>
								<button
									type="button"
									class={deleteButton}
									onClick={() => remove.mutate(todo.id)}
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

export default function Todos() {
	return (
		<div class={container}>
			<Title>Todos | Web UI SSR</Title>
			<Meta name="description" content="TODO list" />
			<h1 class={heading}>Todos</h1>
			<AddTodoForm />
			<Suspense fallback={<p>Loading todos...</p>}>
				<TodoList />
			</Suspense>
		</div>
	);
}
