import { Meta, Title } from "@solidjs/meta";
import { createQuery } from "@tanstack/solid-query";
import { For, Show, Suspense } from "solid-js";
import { todosQueryOptions } from "../queries/todos";
import { getClientTransport } from "../transport-client";
import { container } from "./shared.css";
import {
	checkbox,
	emptyState,
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

function TodoList() {
	const transport = getClientTransport();
	const query = createQuery(() => todosQueryOptions(transport));

	return (
		<Show when={!query.error} fallback={<p class={emptyState}>Failed to load todos.</p>}>
			<Show when={query.data?.length} fallback={<p class={emptyState}>No todos yet.</p>}>
				<ul class={list}>
					<For each={query.data}>
						{(todo) => (
							<li class={item}>
								<input type="checkbox" class={checkbox} checked={todo.completed} disabled />
								<span class={todo.completed ? titleCompleted : titleText}>{todo.title}</span>
								<span class={timestamp}>{formatDate(todo.createdAt)}</span>
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
			<Suspense fallback={<p>Loading todos...</p>}>
				<TodoList />
			</Suspense>
		</div>
	);
}
