import { createConnectQueryKey } from "@connectrpc/connect-query-core";
import { createForm } from "@tanstack/solid-form";
import { createMutation, createQuery } from "@tanstack/solid-query";
import { createFileRoute, Link } from "@tanstack/solid-router";
import { getTodo } from "@web-ui-poc/rpc/gen/todo/v1/todo-TodoService_connectquery";
import { createSignal, Match, Show, Suspense, Switch } from "solid-js";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { toast } from "../components/ui/toast";
import { container } from "../pages/shared.styles";
import {
	backLink,
	detailsEmpty,
	detailsHeading,
	detailsSection,
	detailsText,
	editActions,
	editForm,
	meta,
	statusBadge,
	statusComplete,
	statusPending,
	title,
	titleCompleted,
} from "../pages/todo-detail.styles";
import { todoQueryOptions, updateTodoMutation } from "../queries/todos";
import { validateDetails } from "../validation/todo";
import { viewTransitionName } from "../view-transition";

const MS_PER_SECOND = 1000;

function formatDate(ts: { seconds: number } | undefined): string {
	if (!ts) return "";
	return new Date(ts.seconds * MS_PER_SECOND).toLocaleDateString();
}

// Focused details editor: a single multi-line field seeded with the todo's
// current details, validated against the proto-derived max length, that issues
// an UpdateTodo carrying ONLY `details`. Constructing the mutation vars
// explicitly (never spreading the cached todo) is what preserves explicit
// presence: the submitted value is passed verbatim, so an empty string is a
// deliberate CLEAR and any text is a set — title/completed are left untouched.
// Mounted fresh each time editing opens, so `defaultValues` always reflect the
// latest loaded details.
//
// `initial` is `string | undefined`, honest about the post-spread reality: the
// generated type says `details: string`, but the `{...todo}` spread in
// todoQueryOptions drops the unset explicit-presence field entirely, so a
// never-set todo reads `undefined` at runtime. Normalised to "" for the form
// (display-equivalent: both mean "no details").
function DetailsEditor(props: { id: string; initial: string | undefined; onDone: () => void }) {
	// transport/queryClient come from the TanStack router context (which crosses
	// the code-split/streaming boundary), not Solid context — see __root.tsx.
	const transport = Route.useRouteContext({ select: (c) => c.transport });
	const queryClient = Route.useRouteContext({ select: (c) => c.queryClient });

	const update = createMutation(() => ({
		...updateTodoMutation(transport()),
		onSuccess: (_data, vars) => {
			toast.success("Details saved");
			// Server stays source of truth: refetch this todo so the read view
			// reflects the persisted value (optimistic updates are a4a.3, not here).
			void queryClient().invalidateQueries({
				queryKey: createConnectQueryKey({
					schema: getTodo,
					input: { id: vars.id },
					transport: transport(),
					cardinality: "finite",
				}),
			});
			props.onDone();
		},
		onError: () => {
			toast.error("Failed to save details", "Please try again.");
		},
	}));

	const form = createForm(() => ({
		// `?? ""` handles the never-set case (see the prop note above): the form
		// always works on a string, so Save on an untouched empty editor is a
		// clean details:"" write, never a spurious validation failure.
		defaultValues: { details: props.initial ?? "" },
		onSubmit: ({ value }) => {
			// Guard with the proto-derived validator so over-length details never
			// issue an UpdateTodo RPC. `value.details` is passed as-is: "" clears,
			// text sets — see the explicit-presence note above.
			if (validateDetails(value.details) === undefined) {
				update.mutate({ id: props.id, details: value.details });
			}
		},
	}));

	return (
		<form
			class={editForm}
			onSubmit={(e) => {
				e.preventDefault();
				e.stopPropagation();
				void form.handleSubmit();
			}}
		>
			<form.Field
				name="details"
				validators={{
					// Human-readable, proto-derived max-length message; no lower bound
					// (empty is the legal clear value). See src/validation/todo.ts.
					onChange: ({ value }) => validateDetails(value),
				}}
			>
				{(field) => {
					const error = () => field().state.meta.errors[0];
					return (
						<Field.Root invalid={Boolean(error())}>
							<Field.Label>Details</Field.Label>
							<Field.Textarea
								placeholder="Add details…"
								value={field().state.value}
								onInput={(e) => {
									field().handleChange(e.currentTarget.value);
								}}
								onBlur={() => {
									field().handleBlur();
								}}
								disabled={update.isPending}
							/>
							<Show when={error()}>
								{(message) => <Field.ErrorText>{message()}</Field.ErrorText>}
							</Show>
						</Field.Root>
					);
				}}
			</form.Field>
			<div class={editActions}>
				<Button type="submit" disabled={update.isPending}>
					Save
				</Button>
				<Button
					type="button"
					variant="ghost"
					disabled={update.isPending}
					onClick={() => {
						props.onDone();
					}}
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}

function TodoDetail() {
	const params = Route.useParams();
	// transport comes from the TanStack router context (crosses the code-split/
	// streaming boundary), not Solid context — see __root.tsx.
	const transport = Route.useRouteContext({ select: (c) => c.transport });
	const query = createQuery(() => todoQueryOptions(transport(), params().id));

	// Client-only edit toggle: the details read view is server-rendered; the
	// editor is revealed on interaction (like the delete dialog), so SSR/hydration
	// are unaffected. Closing on save/cancel returns to the read view.
	const [editing, setEditing] = createSignal(false);

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
						<h1
							class={todo().completed ? titleCompleted : title}
							// Shared-element morph target: same name as the list row's title.
							// Plain DOM style (outside Panda's scope, so strictTokens does not
							// apply to this non-token identifier value).
							style={{ "view-transition-name": viewTransitionName(todo().id) }}
						>
							{todo().title}
						</h1>
						<span class={`${statusBadge} ${todo().completed ? statusComplete : statusPending}`}>
							{todo().completed ? "Completed" : "Pending"}
						</span>
						<section class={detailsSection}>
							<h2 class={detailsHeading}>Details</h2>
							{/* Display treats "" (cleared) and never-set identically: both read
							    as "no details". Presence is runtime-only (isFieldSet) and the
							    query cache spreads strip message identity anyway, so this is the
							    correct and simplest choice for display (a4a.1 field guide #1). */}
							<Show when={todo().details} fallback={<p class={detailsEmpty}>No details yet.</p>}>
								<p class={detailsText}>{todo().details}</p>
							</Show>
							<Show
								when={editing()}
								fallback={
									<div class={editActions}>
										<Button
											type="button"
											onClick={() => {
												setEditing(true);
											}}
										>
											Edit details
										</Button>
									</div>
								}
							>
								<DetailsEditor
									id={todo().id}
									initial={todo().details}
									onDone={() => {
										setEditing(false);
									}}
								/>
							</Show>
						</section>
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
