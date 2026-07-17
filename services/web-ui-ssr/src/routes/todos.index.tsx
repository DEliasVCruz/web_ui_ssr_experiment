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

function AddTodoForm() {
	// transport/queryClient come from the TanStack router context (which crosses
	// the code-split/streaming boundary), not Solid context — see __root.tsx.
	const transport = Route.useRouteContext({ select: (c) => c.transport });
	const queryClient = Route.useRouteContext({ select: (c) => c.queryClient });

	const create = createMutation(() => ({
		...createTodoMutation(transport()),
		// Mutation-state pattern (a4a.3): keyed so TodoList can read every in-flight
		// create back via useMutationState and render each as a pending row before
		// the server confirms — no cache write here.
		mutationKey: ["createTodo"],
		onMutate: () => {
			// A client temp id gives the pending row a stable key AND a stable
			// view-transition-name for its whole pending lifetime. UUIDv7 ids are
			// server-generated, so this `temp-` placeholder never collides with a real
			// one. Reconciliation strategy: rely on the settle invalidation — on
			// success the real server row (real id → a NEW view-transition-name)
			// replaces this pending row, so that one row cross-fades rather than
			// morphs. Acceptable: a just-created row has no prior on-screen identity
			// to preserve, and swapping ids in place would mean a bespoke cache write
			// we deliberately avoid for the mutation-state path (field guide #4).
			return { tempId: nextTempId() };
		},
		onSuccess: () => {
			// Clear the form on success (was a manual setTitle(""); now form.reset()).
			form.reset();
			toast.success("Todo added");
		},
		onError: () => {
			toast.error("Failed to add todo", "Please try again.");
		},
		onSettled: () => {
			// Server stays source of truth: refetch so the pending row is replaced by
			// the confirmed row (success) or simply drops with the failed mutation
			// (error). Wrapped in a view transition because, unlike the edit/delete
			// cache-write path, onMutate did NOT touch the cache — so THIS invalidation
			// is the meaningful DOM change (new row in / pending row out), not a
			// redundant post-success no-op (field guide #1).
			withViewTransition(() =>
				queryClient().invalidateQueries({ queryKey: listTodosQueryKey(transport()) }),
			);
		},
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

	// Mutation-state pattern (create): every in-flight CreateTodo surfaced as a
	// pending row. `variables` is the submitted title; `context.tempId` is the
	// stable temp id minted in onMutate (row key + view-transition-name). Filtered
	// to status "pending", so a row exists exactly while the create is outstanding
	// — it drops on success (replaced by the invalidation refetch's real row) or on
	// error (nothing to undo; it was never written to the cache).
	const pendingCreates = useMutationState(() => ({
		filters: { mutationKey: ["createTodo"], status: "pending" as const },
		select: (m) => ({
			tempId: (m.state.context as { tempId?: string } | undefined)?.tempId,
			title: m.state.variables as string,
		}),
	}));

	// Mutation-state pattern (toggle): in-flight TOGGLE variables, so each row can
	// reflect its target completed state immediately while the server confirms,
	// then fall back to the cached truth once the mutation settles. Rollback on
	// failure is implicit — the reflection only exists while the mutation is
	// pending, so a rejected toggle simply reverts, no snapshot needed.
	const pendingToggles = useMutationState(() => ({
		filters: { mutationKey: ["toggleTodo"], status: "pending" as const },
		select: (m) => m.state.variables as { id: string; completed?: boolean },
	}));
	const pendingToggleFor = (id: string) => pendingToggles().find((v) => v.id === id);

	const update = createMutation(() => ({
		...updateTodoMutation(transport()),
		// Keyed so pending toggles are readable via useMutationState above. This
		// instance is toggle-only; the details editor owns its own update mutation.
		mutationKey: ["toggleTodo"],
		// No success toast on toggle: toggling is frequent and a confirmation
		// toast each time is noise. Failures still surface (onError below).
		onSuccess: (_data, vars) => {
			// No optimistic cache write (mutation-state pattern) — invalidate on
			// success so the server value lands in both the list and this todo's
			// detail view.
			void queryClient().invalidateQueries({ queryKey: listTodosQueryKey(transport()) });
			void queryClient().invalidateQueries({ queryKey: todoQueryKey(transport(), vars.id) });
		},
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
		onSettled: () => {
			// Server stays source of truth. NOT wrapped: onMutate already applied the
			// removal, so by settle time old==new and a transition would only waste a
			// snapshot capture (field guide #1).
			void queryClient().invalidateQueries({ queryKey: listTodosQueryKey(transport()) });
		},
	}));

	const hasContent = () => (query.data?.length ?? 0) > 0 || pendingCreates().length > 0;

	return (
		<Show when={!query.error} fallback={<p class={emptyState}>Failed to load todos.</p>}>
			<Show when={hasContent()} fallback={<p class={emptyState}>No todos yet.</p>}>
				<ul class={list}>
					<For each={query.data}>
						{(todo) => {
							// Optimistic toggle reflection: while a toggle for this row is
							// in-flight, show its target completed state; otherwise the cached
							// value. The same signal drives the pending dim/disable styling.
							const pendingToggle = () => pendingToggleFor(todo.id);
							const completed = () => pendingToggle()?.completed ?? todo.completed;
							return (
								<li
									class={item}
									// `data-pending` (attribute presence) drives Panda's `_pending`
									// condition — dim + pointerEvents:none while the toggle is
									// outstanding.
									data-pending={pendingToggle() ? "true" : undefined}
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
										disabled={Boolean(pendingToggle())}
									/>
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
										pending={remove.isPending && remove.variables === todo.id}
										onConfirm={() => {
											remove.mutate(todo.id);
										}}
									/>
								</li>
							);
						}}
					</For>
					{/* Mutation-state pattern (create): pending rows for in-flight creates.
					    Rendered after the confirmed rows; each is dimmed (data-pending) and
					    non-interactive, and carries a temp view-transition-name so it is its
					    own transition group. Replaced by the real row on settle. */}
					<For each={pendingCreates()}>
						{(pending) => (
							<li
								class={item}
								data-pending="true"
								style={{ "view-transition-name": viewTransitionName(pending.tempId ?? "pending") }}
							>
								<Checkbox checked={false} disabled aria-label={pending.title} />
								<span class={titleText}>{pending.title}</span>
								<span class={timestamp} />
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
