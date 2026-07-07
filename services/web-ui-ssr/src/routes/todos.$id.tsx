import { createQuery } from "@tanstack/solid-query";
import { createFileRoute, Link } from "@tanstack/solid-router";
import { Match, Show, Suspense, Switch } from "solid-js";
import { container } from "../pages/shared.styles";
import {
	backLink,
	meta,
	statusBadge,
	statusComplete,
	statusPending,
	title,
	titleCompleted,
} from "../pages/todo-detail.styles";
import { todoQueryOptions } from "../queries/todos";
import { useTransport } from "../transport-context";

const MS_PER_SECOND = 1000;

function formatDate(ts: { seconds: number } | undefined): string {
	if (!ts) return "";
	return new Date(ts.seconds * MS_PER_SECOND).toLocaleDateString();
}

function TodoDetail() {
	const params = Route.useParams();
	const transport = useTransport();
	const query = createQuery(() => todoQueryOptions(transport, params().id));

	return (
		<Switch>
			<Match when={query.isError}>
				<p>Error loading todo. Please try again later.</p>
			</Match>
			<Match when={query.isSuccess && query.data === null}>
				<p>Todo not found.</p>
			</Match>
			<Match when={query.data}>
				{(todo) => (
					<>
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
			</Match>
		</Switch>
	);
}

export const Route = createFileRoute("/todos/$id")({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(todoQueryOptions(context.transport, params.id)),
	head: ({ loaderData }) => {
		const todo = loaderData as { title?: string } | null | undefined;
		return {
			meta: [
				{ title: todo?.title ? `${todo.title} | Web UI SSR` : "Todo | Web UI SSR" },
				{
					name: "description",
					content: todo?.title ? `TODO: ${todo.title}` : "Todo detail page",
				},
			],
		};
	},
	component: () => (
		<div class={container}>
			<Link to="/todos" class={backLink}>
				&larr; Back to Todos
			</Link>
			<Suspense fallback={<p>Loading todo...</p>}>
				<TodoDetail />
			</Suspense>
		</div>
	),
});
