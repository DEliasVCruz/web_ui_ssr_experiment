import { Meta, Title } from "@solidjs/meta";
import { A, useParams } from "@solidjs/router";
import { createQuery } from "@tanstack/solid-query";
import { Show, Suspense } from "solid-js";
import { todoQueryOptions } from "../queries/todos";
import { getClientTransport } from "../transport-client";
import { container } from "./shared.css";
import {
	backLink,
	meta,
	statusBadge,
	statusComplete,
	statusPending,
	title,
	titleCompleted,
} from "./todo-detail.css";

const MS_PER_SECOND = 1000;

function formatDate(ts: { seconds: bigint } | undefined): string {
	if (!ts) return "";
	return new Date(Number(ts.seconds) * MS_PER_SECOND).toLocaleDateString();
}

function TodoDetail() {
	const params = useParams<{ id: string }>();
	const transport = getClientTransport();
	const query = createQuery(() => todoQueryOptions(transport, params.id));

	return (
		<Show when={query.data} fallback={<p>Todo not found.</p>}>
			{(todo) => (
				<>
					<Title>{todo().title} | Web UI SSR</Title>
					<Meta name="description" content={`TODO: ${todo().title}`} />
					<h1 class={todo().completed ? titleCompleted : title}>{todo().title}</h1>
					<span class={`${statusBadge} ${todo().completed ? statusComplete : statusPending}`}>
						{todo().completed ? "Completed" : "Pending"}
					</span>
					<div class={meta}>
						<span>Created: {formatDate(todo().createdAt)}</span>
						<Show when={todo().updatedAt}>
							<span>Updated: {formatDate(todo().updatedAt)}</span>
						</Show>
					</div>
				</>
			)}
		</Show>
	);
}

export default function TodoDetailPage() {
	return (
		<div class={container}>
			<A href="/todos" class={backLink}>
				&larr; Back to Todos
			</A>
			<Suspense fallback={<p>Loading todo...</p>}>
				<TodoDetail />
			</Suspense>
		</div>
	);
}
