import { createForm } from "@tanstack/solid-form";
import { createMutation, createQuery, useMutationState } from "@tanstack/solid-query";
import { createFileRoute, Link } from "@tanstack/solid-router";
import { createSignal, For, Show, Suspense } from "solid-js";
import { cx } from "../../styled-system/css";
import { button } from "../../styled-system/recipes";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { toast } from "../components/ui/toast";
import { container } from "../pages/shared.styles";
import {
	addForm,
	controlShrink,
	emptyState,
	heading,
	item,
	list,
	srOnly,
	timestamp,
	titleCompleted,
	titleText,
} from "../pages/todos.styles";
import {
	type CachedTodo,
	createTodoMutation,
	deleteTodoMutation,
	listTodosQueryKey,
	todoQueryKey,
	todosQueryOptions,
	updateTodoMutation,
} from "../queries/todos";
import { validateTitle } from "../validation/todo";
import { viewTransitionName, withViewTransition } from "../view-transition";

const MS_PER_SECOND = 1000;

function formatDate(ts: { seconds: number } | undefined): string {
	if (!ts) return "";
	return new Date(ts.seconds * MS_PER_SECOND).toLocaleDateString();
}

// Monotonic client-only counter for optimistic-create temp ids. Deliberately NOT
// crypto.randomUUID(): that exists only in a secure context (HTTPS / localhost),
// so it is undefined when the app is served over plain HTTP (e.g. the e2e browser
// reaching it via host.docker.internal) and would throw inside onMutate. A
// per-session counter is collision-free across concurrent in-flight creates,
// needs no secure context, and is only ever read client-side (onMutate).
let tempIdCounter = 0;
function nextTempId(): string {
	tempIdCounter += 1;
	return `temp-${String(tempIdCounter)}`;
}

/**
 * True for the client-minted optimistic-create placeholder ids above. Server ids
 * are UUIDv7, so the `temp-` prefix can never collide with a real id. Rows with
 * a temp id render pending (dimmed, non-interactive) until the settle refetch
 * atomically swaps the cached list for the server's (temp row → real row).
 */
function isTempId(id: string): boolean {
	return id.startsWith("temp-");
}

function AddTodoForm() {
	// transport/queryClient come from the TanStack router context (which crosses
	// the code-split/streaming boundary), not Solid context — see __root.tsx.
	const transport = Route.useRouteContext({ select: (c) => c.transport });
	const queryClient = Route.useRouteContext({ select: (c) => c.queryClient });

	const create = createMutation(() => ({
		...createTodoMutation(transport()),
		// Cache-write optimistic CREATE (a4a.3 fix pass, review F1/F3). The earlier
		// mutation-state approach had two empirically proven de-optimizing windows:
		// the pending row vanished for the settle-refetch RTT when the mutation
		// flipped to success (F1), and a refetch landing while a post-commit create
		// was still pending could show the row twice (F3). Writing a temp row into
		// the LIST cache at onMutate dissolves both: the cache is the single source
		// of truth from click to reconciliation, and a landing refetch atomically
		// replaces the whole cached array — temp row → real row in one write, so
		// the row can neither vanish nor duplicate.
		onMutate: async (title) => {
			const listKey = listTodosQueryKey(transport());
			// Refetch race guard: cancel any in-flight list fetch so a late stale
			// response cannot clobber the temp row below.
			await queryClient().cancelQueries({ queryKey: listKey });
			const previous = queryClient().getQueryData<CachedTodo[]>(listKey);
			// The temp id (see nextTempId) is the row key AND its view-transition-name
			// for the whole pending lifetime; the real server row gets a NEW name after
			// reconciliation, so that one row swaps rather than morphs — acceptable, a
			// just-created row has no prior on-screen identity to preserve.
			const tempId = nextTempId();
			// The optimistic append IS the DOM change → VT-wrapped at the write moment
			// (field guide #1). The update is synchronous (resolved promise), so the
			// transition NEVER spans a network await and input is not suppressed
			// beyond the capture itself.
			withViewTransition(() => {
				queryClient().setQueryData<CachedTodo[]>(listKey, (old) => [
					...(old ?? []),
					{ $typeName: "todo.v1.Todo", id: tempId, title, completed: false },
				]);
				return Promise.resolve();
			});
			return { previous, listKey };
		},
		onSuccess: () => {
			// Clear the form on success (was a manual setTitle(""); now form.reset()).
			form.reset();
			toast.success("Todo added");
		},
		onError: (_err, _title, context) => {
			// Restore the pre-mutation snapshot — a second DOM change, so wrap it too
			// (the temp row exit-animates); withViewTransition re-checks gating per call.
			if (context?.previous !== undefined) {
				withViewTransition(() => {
					queryClient().setQueryData<CachedTodo[]>(context.listKey, context.previous);
					return Promise.resolve();
				});
			}
			toast.error("Failed to add todo", "Please try again.");
		},
		// Server stays source of truth. RETURN the invalidation promise (TanStack's
		// keep-pending-until-refetch pattern): query-core awaits it before
		// dispatching the terminal state, so "settled" means the fresh list has
		// actually landed. The temp row's persistence does not depend on mutation
		// status (it lives in the cache), but the returned promise pins the row's
		// pending styling to real reconciliation. NOT VT-wrapped: onMutate already
		// applied the row, the temp→real swap renders near-identical content, and a
		// transition here would suppress input across a network await (review F1).
		onSettled: () => queryClient().invalidateQueries({ queryKey: listTodosQueryKey(transport()) }),
	}));

	// Form state now lives in @tanstack/solid-form (no createSignal for the title).
	// A single `title` field with non-empty (trim) validation; onSubmit mutates.
	const form = createForm(() => ({
		defaultValues: { title: "" },
		onSubmit: ({ value }) => {
			// Guard with the proto-derived validator so an invalid title (empty,
			// whitespace-only, or over max length) never issues a CreateTodo RPC —
			// even if the button were somehow clicked while invalid.
			if (validateTitle(value.title) === undefined) {
				create.mutate(value.title.trim());
			}
		},
	}));

	return (
		<form
			class={addForm}
			onSubmit={(e) => {
				e.preventDefault();
				e.stopPropagation();
				void form.handleSubmit();
			}}
		>
			<form.Field
				name="title"
				validators={{
					// Human-readable messages derived from the proto constraints:
					// "Title is required" for empty/whitespace, a max-length message
					// past the proto's max_len. See src/validation/todo.ts.
					onChange: ({ value }) => validateTitle(value),
				}}
			>
				{(field) => {
					const error = () => field().state.meta.errors[0];
					return (
						// `invalid` wires Ark's aria-invalid + aria-describedby so the
						// error is announced and rendered by Field.ErrorText.
						<Field.Root invalid={Boolean(error())}>
							{/* Visually-hidden label gives the input a real accessible name
							    (input gets aria-labelledby → this label) beyond the placeholder. */}
							<Field.Label class={srOnly}>New todo</Field.Label>
							<Field.Input
								type="text"
								placeholder="What needs to be done?"
								value={field().state.value}
								onInput={(e) => {
									field().handleChange(e.currentTarget.value);
								}}
								onBlur={() => {
									field().handleBlur();
								}}
								disabled={create.isPending}
							/>
							<Show when={error()}>
								{(message) => <Field.ErrorText>{message()}</Field.ErrorText>}
							</Show>
						</Field.Root>
					);
				}}
			</form.Field>
			{/* Button disabled state is derived reactively from form state (the
			    current title value) plus the mutation's pending flag — this is what
			    the hydration guard relies on: typing must reactively enable Add. */}
			<form.Subscribe selector={(state) => state.values.title}>
				{(title) => (
					<Button type="submit" disabled={create.isPending || !title().trim()}>
						Add
					</Button>
				)}
			</form.Subscribe>
		</form>
	);
}

// Confirm-before-delete (ol9.4). The Delete control is the Ark Dialog trigger;
// the dialog (focus-trapped, ESC/Cancel to dismiss, aria-modal) only mounts its
// portalled content when open — client-only, so SSR/hydration are unaffected.
// Cancel closes with no effect; Confirm calls onConfirm then closes.
function DeleteTodoDialog(props: { title: string; pending: boolean; onConfirm: () => void }) {
	const [open, setOpen] = createSignal(false);
	return (
		<Dialog.Root open={open()} onOpenChange={(details) => setOpen(details.open)}>
			{/* Dialog.Trigger is itself an ark.button, so the Panda button recipe is
			    applied directly (no asChild proxy spread). */}
			<Dialog.Trigger
				type="button"
				disabled={props.pending}
				class={cx(button({ variant: "outline", size: "sm" }), controlShrink)}
			>
				Delete
			</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Backdrop />
				<Dialog.Positioner>
					<Dialog.Content>
						<Dialog.Title>Delete todo?</Dialog.Title>
						<Dialog.Description>
							This permanently deletes “{props.title}”. This action cannot be undone.
						</Dialog.Description>
						<Dialog.Actions>
							<Dialog.CloseTrigger type="button" class={button({ variant: "ghost" })}>
								Cancel
							</Dialog.CloseTrigger>
							<Button
								type="button"
								variant="dangerSolid"
								onClick={() => {
									props.onConfirm();
									setOpen(false);
								}}
							>
								Delete
							</Button>
						</Dialog.Actions>
					</Dialog.Content>
				</Dialog.Positioner>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function TodoList() {
	const transport = Route.useRouteContext({ select: (c) => c.transport });
	const queryClient = Route.useRouteContext({ select: (c) => c.queryClient });
	const query = createQuery(() => todosQueryOptions(transport()));

	// Mutation-state pattern (toggle): in-flight TOGGLE variables, so each row can
	// reflect its target completed state immediately while the server confirms.
	// Rollback on failure is implicit — the reflection only exists while the
	// mutation is unsettled, so a rejected toggle simply reverts, no snapshot
	// needed. Filtered to status "pending": because onSuccess below RETURNS the
	// invalidation promises, query-core keeps the mutation pending until the
	// refetched truth is in the cache, so this reflection persists exactly until
	// the cache agrees with it (review F2 — no bounce-back window).
	const pendingToggles = useMutationState(() => ({
		filters: { mutationKey: ["toggleTodo"], status: "pending" as const },
		select: (m) => m.state.variables as { id: string; completed?: boolean },
	}));
	const pendingToggleFor = (id: string) => pendingToggles().find((v) => v.id === id);

	const update = createMutation(() => ({
		...updateTodoMutation(transport(), "toggle_todo"),
		// Keyed so pending toggles are readable via useMutationState above. This
		// instance is toggle-only; the details editor owns its own update mutation.
		mutationKey: ["toggleTodo"],
		// No success toast on toggle: toggling is frequent and a confirmation
		// toast each time is noise. Failures still surface (onError below).
		//
		// RETURNING the invalidation promises is what makes this bounce-free
		// (review F2): query-core awaits onSuccess before flipping the mutation to
		// success, so the pending reflection above outlives the refetch — the
		// checkbox never falls back to stale cache for the RTT, and it stays
		// disabled until the server truth has landed (no second click mutating
		// from stale state). The GetTodo invalidation resolves immediately when
		// that query is inactive (detail page unmounted) and refetches otherwise.
		onSuccess: (_data, vars) =>
			Promise.all([
				queryClient().invalidateQueries({ queryKey: listTodosQueryKey(transport()) }),
				queryClient().invalidateQueries({ queryKey: todoQueryKey(transport(), vars.id) }),
			]),
		onError: () => {
			toast.error("Failed to update todo", "Please try again.");
		},
	}));

	const remove = createMutation(() => ({
		...deleteTodoMutation(transport()),
		// Cache-snapshot rollback pattern (delete): snapshot → optimistic remove →
		// restore on error → invalidate on settle.
		onMutate: async (id) => {
			const listKey = listTodosQueryKey(transport());
			// Refetch race guard (field guide): cancel any in-flight list fetch so a
			// late response cannot clobber the optimistic removal below.
			await queryClient().cancelQueries({ queryKey: listKey });
			const previous = queryClient().getQueryData<CachedTodo[]>(listKey);
			// The optimistic removal IS the DOM change → wrap it so the row
			// exit-animates (field guide #1). setQueryData is synchronous; the
			// resolved promise lets startViewTransition capture the post-write DOM.
			withViewTransition(() => {
				queryClient().setQueryData<CachedTodo[]>(listKey, (old) => old?.filter((t) => t.id !== id));
				return Promise.resolve();
			});
			return { previous, listKey };
		},
		onSuccess: (_data, id) => {
			toast.success("Todo deleted");
			queryClient().removeQueries({ queryKey: todoQueryKey(transport(), id) });
		},
		onError: (_err, _id, context) => {
			// Restore the pre-mutation snapshot — a second DOM change, so wrap it too
			// (the row re-enters); withViewTransition re-checks gating per call.
			if (context?.previous !== undefined) {
				withViewTransition(() => {
					// Explicit generic: the connect-query key is typed to the RPC response
					// (ListTodosResponse), but this cache actually stores the normalised
					// CachedTodo[] the queryFn returns.
					queryClient().setQueryData<CachedTodo[]>(context.listKey, context.previous);
					return Promise.resolve();
				});
			}
			toast.error("Failed to delete todo", "Please try again.");
		},
		// Server stays source of truth. RETURNED (keep-pending-until-refetch, review
		// F1 pattern) so "settled" means the refreshed list actually landed. NOT
		// VT-wrapped: onMutate already applied the removal, so by settle time
		// old==new and a transition would only waste a snapshot capture and
		// suppress input across a network await (field guide #1).
		onSettled: () => queryClient().invalidateQueries({ queryKey: listTodosQueryKey(transport()) }),
	}));

	return (
		<Show when={!query.error} fallback={<p class={emptyState}>Failed to load todos.</p>}>
			<Show when={query.data?.length} fallback={<p class={emptyState}>No todos yet.</p>}>
				<ul class={list}>
					<For each={query.data}>
						{(todo) => {
							// Optimistic toggle reflection: while a toggle for this row is
							// unsettled, show its target completed state; otherwise the cached
							// value. A row is pending while a toggle for it is outstanding OR
							// while it is an optimistic (temp-id) create awaiting the settle
							// refetch — both drive the dim/disable styling below.
							const pendingToggle = () => pendingToggleFor(todo.id);
							const pending = () => Boolean(pendingToggle()) || isTempId(todo.id);
							const completed = () => pendingToggle()?.completed ?? todo.completed;
							return (
								<li
									class={item}
									// `data-pending` (attribute presence) drives Panda's `_pending`
									// condition — dim + pointerEvents:none while the row reflects
									// an unconfirmed mutation.
									data-pending={pending() ? "true" : undefined}
									// Plain DOM style (outside Panda's scope, so strictTokens does
									// not apply): a stable per-todo view-transition-name makes each
									// row its own transition group, so add/remove animate and
									// surviving rows morph to their new positions. The CSS in
									// styles.css targets these groups with the universal `*`
									// selector (root is the only other named group and is never a
									// sole snapshot, so the row-only rules never touch it).
									style={{ "view-transition-name": viewTransitionName(todo.id) }}
								>
									<Checkbox
										checked={completed()}
										aria-label={todo.title}
										onCheckedChange={(details) => {
											update.mutate({ id: todo.id, completed: details.checked === true });
										}}
										disabled={pending()}
									/>
									{/* A temp row has no server id to link to (the detail route
									    would 404), so it renders a plain span until reconciled;
									    pointerEvents:none already blocks clicks, this also keeps
									    keyboard focus honest. */}
									<Show
										when={!isTempId(todo.id)}
										fallback={
											<span class={completed() ? titleCompleted : titleText}>{todo.title}</span>
										}
									>
										<Link
											to="/todos/$id"
											params={{ id: todo.id }}
											class={completed() ? titleCompleted : titleText}
										>
											{todo.title}
										</Link>
									</Show>
									<span class={timestamp}>{formatDate(todo.createdAt)}</span>
									<DeleteTodoDialog
										title={todo.title}
										pending={
											(remove.isPending && remove.variables === todo.id) || isTempId(todo.id)
										}
										onConfirm={() => {
											remove.mutate(todo.id);
										}}
									/>
								</li>
							);
						}}
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
