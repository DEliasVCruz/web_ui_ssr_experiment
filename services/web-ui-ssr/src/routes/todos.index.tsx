import { createForm } from "@tanstack/solid-form";
import { createMutation, createQuery, useMutationState } from "@tanstack/solid-query";
import { createFileRoute, Link } from "@tanstack/solid-router";
import { createSignal, For, Show, Suspense } from "solid-js";
import { cx } from "../../styled-system/css";
import { button } from "../../styled-system/recipes";
import { OfflineRouteError, StaleIndicator } from "../components/offline-banner";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { toast } from "../components/ui/toast";
import { captureActionContext } from "../observability/browser-events";
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
	CREATE_TODO_KEY,
	createTodoMutation,
	DELETE_TODO_KEY,
	deleteTodoMutation,
	listTodosQueryKey,
	settleInvalidate,
	TOGGLE_TODO_KEY,
	todoQueryKey,
	todosQueryOptions,
	updateTodoMutation,
} from "../queries/todos";
import { mintTodoId } from "../queue/mutation-ids";
import { validateTitle } from "../validation/todo";
import { viewTransitionName, withViewTransition } from "../view-transition";

const MS_PER_SECOND = 1000;

function formatDate(ts: { seconds: number } | undefined): string {
	if (!ts) return "";
	return new Date(ts.seconds * MS_PER_SECOND).toLocaleDateString();
}

function AddTodoForm() {
	// transport/queryClient come from the TanStack router context (which crosses
	// the code-split/streaming boundary), not Solid context — see __root.tsx.
	const transport = Route.useRouteContext({ select: (c) => c.transport });
	const queryClient = Route.useRouteContext({ select: (c) => c.queryClient });

	const create = createMutation(() => ({
		...createTodoMutation(transport()),
		// Keyed so the paused mutation can be persisted/rehydrated (offline queue,
		// 1w9.4) and so pending creates are readable via useMutationState below.
		mutationKey: CREATE_TODO_KEY,
		// Cache-write optimistic CREATE (a4a.3 fix pass, review F1/F3). Writing the
		// row into the LIST cache at onMutate is the single source of truth from
		// click to reconciliation: a landing refetch atomically replaces the whole
		// cached array, so the row can neither vanish nor duplicate. With the
		// client-minted id (1w9.4 §4.1) the optimistic row already carries its FINAL
		// id — no temp→real swap — so its identity (and view-transition-name) is
		// stable across the settle refetch AND across an offline→online flush.
		onMutate: async (vars) => {
			const listKey = listTodosQueryKey(transport());
			// Refetch race guard: cancel any in-flight list fetch so a late stale
			// response cannot clobber the optimistic row below.
			await queryClient().cancelQueries({ queryKey: listKey });
			const previous = queryClient().getQueryData<CachedTodo[]>(listKey);
			const optimistic: CachedTodo = {
				$typeName: "todo.v1.Todo",
				id: vars.id,
				title: vars.title,
				completed: false,
			};
			// The optimistic append IS the DOM change → VT-wrapped at the write moment
			// (field guide #1). The update is synchronous (resolved promise), so the
			// transition NEVER spans a network await and input is not suppressed
			// beyond the capture itself. Skipped naturally on the offline flush —
			// query-core never re-runs onMutate on a resumed mutation.
			withViewTransition(() => {
				queryClient().setQueryData<CachedTodo[]>(listKey, (old) => [...(old ?? []), optimistic]);
				return Promise.resolve();
			});
			// Seed the detail cache so an offline-created row is deep-linkable this
			// session (the real client id makes /todos/$id valid). Optimistic → not
			// persisted (F8); after a reload the flush refetch supplies server truth.
			queryClient().setQueryData<CachedTodo | null>(todoQueryKey(transport(), vars.id), optimistic);
			return { previous, listKey };
		},
		onSuccess: () => {
			// Clear the form on success (was a manual setTitle(""); now form.reset()).
			form.reset();
			toast.success("Todo added");
		},
		onError: (_err, _vars, context) => {
			// Restore the pre-mutation snapshot — a second DOM change, so wrap it too
			// (the row exit-animates); withViewTransition re-checks gating per call.
			if (context?.previous !== undefined) {
				withViewTransition(() => {
					queryClient().setQueryData<CachedTodo[]>(context.listKey, context.previous);
					return Promise.resolve();
				});
			}
			toast.error("Failed to add todo", "Please try again.");
		},
		// Server stays source of truth. OFFLINE-GUARDED keep-pending-until-refetch
		// (1w9.4 §4.5): online it RETURNS the invalidation promise so "settled" means
		// the fresh list landed (pins the row's pending styling to reconciliation);
		// offline it fires-and-forgets so a queued create is never wedged pending on
		// a refetch that can't complete. Reconciliation reads server truth via the
		// refetch (the RESPONSE), never the request. NOT VT-wrapped.
		onSettled: () => settleInvalidate(queryClient(), [listTodosQueryKey(transport())]),
	}));

	// Form state now lives in @tanstack/solid-form (no createSignal for the title).
	// A single `title` field with non-empty (trim) validation; onSubmit mutates.
	const form = createForm(() => ({
		defaultValues: { title: "" },
		onSubmit: ({ value }) => {
			// Guard with the proto-derived validator so an invalid title (empty,
			// whitespace-only, or over max length) never issues a CreateTodo RPC —
			// even if the button were somehow clicked while invalid. Mint the FINAL
			// client id and capture the trace context AT ENQUEUE (1w9.4): both are
			// carried in the variables and persisted with the mutation, so an offline
			// replay is byte-identical and reuses the original trace_id.
			if (validateTitle(value.title) === undefined) {
				create.mutate({
					id: mintTodoId(),
					title: value.title.trim(),
					__trace: captureActionContext("create_todo"),
				});
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
		filters: { mutationKey: TOGGLE_TODO_KEY, status: "pending" as const },
		select: (m) => m.state.variables as { id: string; completed?: boolean },
	}));
	const pendingToggleFor = (id: string) => pendingToggles().find((v) => v.id === id);

	// In-flight/queued CREATE ids (1w9.4): a create is `pending` while its RPC is
	// live OR while paused offline in the queue, so its optimistic row (already
	// carrying its final client id) renders pending until the settle refetch lands
	// or the offline flush confirms it — the successor to the old temp-id check.
	const pendingCreates = useMutationState(() => ({
		filters: { mutationKey: CREATE_TODO_KEY, status: "pending" as const },
		select: (m) => (m.state.variables as { id: string }).id,
	}));
	const isPendingCreate = (id: string) => pendingCreates().includes(id);

	const update = createMutation(() => ({
		...updateTodoMutation(transport()),
		// Keyed so pending toggles are readable via useMutationState above AND so the
		// paused mutation can be persisted/rehydrated (offline queue, 1w9.4). This
		// instance is toggle-only; the details editor owns its own update mutation.
		mutationKey: TOGGLE_TODO_KEY,
		// No success toast on toggle: toggling is frequent and a confirmation
		// toast each time is noise. Failures still surface (onError below).
		//
		// RETURNING the invalidation promises is what makes this bounce-free
		// (review F2): query-core awaits onSuccess before flipping the mutation to
		// success, so the pending reflection above outlives the refetch. Offline
		// -guarded (1w9.4 §4.5): online it returns the promise (keep-pending);
		// offline it fires-and-forgets so a queued toggle is never wedged pending.
		onSuccess: (_data, vars) =>
			settleInvalidate(queryClient(), [
				listTodosQueryKey(transport()),
				todoQueryKey(transport(), vars.id),
			]),
		onError: () => {
			toast.error("Failed to update todo", "Please try again.");
		},
	}));

	const remove = createMutation(() => ({
		...deleteTodoMutation(transport()),
		// Keyed so the paused mutation can be persisted/rehydrated (offline queue).
		mutationKey: DELETE_TODO_KEY,
		// Cache-snapshot rollback pattern (delete): snapshot → optimistic remove →
		// restore on error → invalidate on settle.
		onMutate: async (vars) => {
			const listKey = listTodosQueryKey(transport());
			// Refetch race guard (field guide): cancel any in-flight list fetch so a
			// late response cannot clobber the optimistic removal below.
			await queryClient().cancelQueries({ queryKey: listKey });
			const previous = queryClient().getQueryData<CachedTodo[]>(listKey);
			// The optimistic removal IS the DOM change → wrap it so the row
			// exit-animates (field guide #1). setQueryData is synchronous; the
			// resolved promise lets startViewTransition capture the post-write DOM.
			withViewTransition(() => {
				queryClient().setQueryData<CachedTodo[]>(listKey, (old) =>
					old?.filter((t) => t.id !== vars.id),
				);
				return Promise.resolve();
			});
			return { previous, listKey };
		},
		onSuccess: (_data, vars) => {
			toast.success("Todo deleted");
			queryClient().removeQueries({ queryKey: todoQueryKey(transport(), vars.id) });
		},
		onError: (_err, _vars, context) => {
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
		// Server stays source of truth. OFFLINE-GUARDED keep-pending-until-refetch
		// (1w9.4 §4.5): online it returns the promise (so "settled" means the
		// refreshed list landed); offline it fires-and-forgets. NOT VT-wrapped:
		// onMutate already applied the removal, so by settle time old==new.
		onSettled: () => settleInvalidate(queryClient(), [listTodosQueryKey(transport())]),
	}));

	// Data-first ordering (1w9.3 review F2): whenever we HAVE list data — SSR
	// -hydrated or restored from IndexedDB — render it, even if a background
	// refetch is currently erroring (show a stale indicator, never blank the list).
	// The bare error screen is reserved for the genuine no-data-at-all case.
	return (
		<Show
			when={query.data}
			fallback={
				<Show when={query.isError} fallback={<p class={emptyState}>No todos yet.</p>}>
					<p class={emptyState}>Failed to load todos.</p>
				</Show>
			}
		>
			{(todos) => (
				<>
					<Show when={query.isError}>
						<StaleIndicator />
					</Show>
					<Show when={todos().length} fallback={<p class={emptyState}>No todos yet.</p>}>
						<ul class={list}>
							<For each={todos()}>
								{(todo) => {
									// Optimistic reflection: while a toggle for this row is unsettled,
									// show its target completed state; otherwise the cached value. A
									// row is pending while a toggle for it is outstanding OR while it
									// is an optimistic create still in-flight/queued — both drive the
									// dim/disable styling below.
									const pendingToggle = () => pendingToggleFor(todo.id);
									const pending = () => Boolean(pendingToggle()) || isPendingCreate(todo.id);
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
											// surviving rows morph to their new positions. With the client
											// id this name is stable across the offline→online flush too.
											style={{ "view-transition-name": viewTransitionName(todo.id) }}
										>
											<Checkbox
												checked={completed()}
												aria-label={todo.title}
												onCheckedChange={(details) => {
													update.mutate({
														id: todo.id,
														completed: details.checked === true,
														__trace: captureActionContext("toggle_todo"),
													});
												}}
												disabled={pending()}
											/>
											{/* The client-minted id is a real UUID, so the row is always
											    deep-linkable — even an offline-created one (resolved from
											    the seeded/persisted cache). */}
											<Link
												to="/todos/$id"
												params={{ id: todo.id }}
												class={completed() ? titleCompleted : titleText}
											>
												{todo.title}
											</Link>
											<span class={timestamp}>{formatDate(todo.createdAt)}</span>
											<DeleteTodoDialog
												title={todo.title}
												pending={
													(remove.isPending && remove.variables.id === todo.id) ||
													isPendingCreate(todo.id)
												}
												onConfirm={() => {
													remove.mutate({
														id: todo.id,
														__trace: captureActionContext("delete_todo"),
													});
												}}
											/>
										</li>
									);
								}}
							</For>
						</ul>
					</Show>
				</>
			)}
		</Show>
	);
}

export const Route = createFileRoute("/todos/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(todosQueryOptions(context.transport)),
	// Designed offline/error screen (1w9.3 review F1) in place of TanStack's
	// generic error boundary — e.g. a loader that fails offline with no cached list.
	errorComponent: OfflineRouteError,
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
