import { createConnectQueryKey } from "@connectrpc/connect-query-core";
import { createMutation, createQuery } from "@tanstack/solid-query";
import { createFileRoute, Link } from "@tanstack/solid-router";
import { getTodo, listTodos } from "@web-ui-poc/rpc/gen/todo/v1/todo-TodoService_connectquery";
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
	createTodoMutation,
	deleteTodoMutation,
	todosQueryOptions,
	updateTodoMutation,
} from "../queries/todos";

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
	const [title, setTitle] = createSignal("");

	const create = createMutation(() => ({
		...createTodoMutation(transport()),
		onSuccess: () => {
			setTitle("");
			toast.success("Todo added");
			void queryClient().invalidateQueries({
				queryKey: createConnectQueryKey({
					schema: listTodos,
					transport: transport(),
					cardinality: undefined,
				}),
			});
		},
		onError: () => {
			toast.error("Failed to add todo", "Please try again.");
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
			<Field.Root>
				{/* Visually-hidden label gives the input a real accessible name
				    (input gets aria-labelledby → this label) beyond the placeholder. */}
				<Field.Label class={srOnly}>New todo</Field.Label>
				<Field.Input
					type="text"
					placeholder="What needs to be done?"
					value={title()}
					onInput={(e) => setTitle(e.currentTarget.value)}
					disabled={create.isPending}
				/>
			</Field.Root>
			<Button type="submit" disabled={create.isPending || !title().trim()}>
				Add
			</Button>
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

	const update = createMutation(() => ({
		...updateTodoMutation(transport()),
		// No success toast on toggle: toggling is frequent and a confirmation
		// toast each time is noise. Failures still surface (onError below).
		onSuccess: (_data, vars) => {
			void queryClient().invalidateQueries({
				queryKey: createConnectQueryKey({
					schema: listTodos,
					transport: transport(),
					cardinality: undefined,
				}),
			});
			void queryClient().invalidateQueries({
				queryKey: createConnectQueryKey({
					schema: getTodo,
					input: { id: vars.id },
					transport: transport(),
					cardinality: "finite",
				}),
			});
		},
		onError: () => {
			toast.error("Failed to update todo", "Please try again.");
		},
	}));

	const remove = createMutation(() => ({
		...deleteTodoMutation(transport()),
		onSuccess: (_data, id) => {
			toast.success("Todo deleted");
			void queryClient().invalidateQueries({
				queryKey: createConnectQueryKey({
					schema: listTodos,
					transport: transport(),
					cardinality: undefined,
				}),
			});
			queryClient().removeQueries({
				queryKey: createConnectQueryKey({
					schema: getTodo,
					input: { id },
					transport: transport(),
					cardinality: "finite",
				}),
			});
		},
		onError: () => {
			toast.error("Failed to delete todo", "Please try again.");
		},
	}));

	return (
		<Show when={!query.error} fallback={<p class={emptyState}>Failed to load todos.</p>}>
			<Show when={query.data?.length} fallback={<p class={emptyState}>No todos yet.</p>}>
				<ul class={list}>
					<For each={query.data}>
						{(todo) => (
							<li class={item}>
								<Checkbox
									checked={todo.completed}
									aria-label={todo.title}
									onCheckedChange={(details) => {
										update.mutate({ id: todo.id, completed: details.checked === true });
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
								<DeleteTodoDialog
									title={todo.title}
									pending={remove.isPending && remove.variables === todo.id}
									onConfirm={() => {
										remove.mutate(todo.id);
									}}
								/>
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
