import type { Transport } from "@connectrpc/connect";
import type { QueryClient } from "@tanstack/solid-query";
import {
	CREATE_TODO_KEY,
	createTodoMutation,
	DELETE_TODO_KEY,
	deleteTodoMutation,
	EDIT_TODO_KEY,
	listTodosQueryKey,
	settleInvalidate,
	TOGGLE_TODO_KEY,
	todoQueryKey,
	type UpdateTodoVars,
	updateTodoMutation,
} from "../queries/todos";

// setMutationDefaults scaffolding for the offline queue (task 1w9.4 §4.2).
//
// A persisted paused mutation loses its functions: when it is rehydrated from
// IndexedDB the mutation is rebuilt from only its `mutationKey` + serialized
// `state` (variables), with NO mutationFn and NO handlers — the component that
// created it is not mounted after a reload. `setMutationDefaults(key, …)` supplies
// them by key, and query-core merges them in `defaultMutationOptions` whenever a
// keyed mutation is built. So this MUST run before hydrate/resume.
//
// The handlers here are the REPLAY path only. onMutate is deliberately absent:
// query-core never re-runs onMutate when continuing a restored mutation (verified
// in mutation.execute — the `restored` branch skips it), which is exactly why the
// flush is View-Transition-free. The live (mounted) mutations in the route
// components still own their optimistic onMutate + toasts + rollback; those inline
// options override these defaults for the live path. Reconciliation reads the
// authoritative RESPONSE via an invalidation refetch (never the request), and is
// offline-guarded via settleInvalidate so a flush is never wedged pending.
//
// SERIALIZED REPLAY (task 1w9.4 review F1). resumePausedMutations() is Promise.all
// — fully CONCURRENT — so without a scope a queued edit can race ahead of the
// create it targets and hit NOT_FOUND (reachable: offline-create → deep-link the
// seeded detail → queue an edit → reconnect). query-core serializes only mutations
// that share `options.scope.id`: canRun() runs just the first pending mutation of a
// scope, and runNext() continues the next paused one when it settles — strict FIFO
// by creation order. We give every offline-capable mutation ONE queue-wide scope.
// Why queue-wide, not per-todo: our architecture builds a SINGLE mutation observer
// per action key with scope fixed in its options at build time (mutate()'s per-call
// options feed only the settle callbacks, never scope) and a create's id is minted
// at submit, so scope cannot be derived from per-call variables. Global
// serialization is a superset of the required create-before-edit ordering, matches
// the FIFO mental model, and costs only cross-todo parallelism online — negligible
// for user-paced writes. The scope MUST live in these DEFAULTS: defaultMutationOptions
// merges getMutationDefaults(key) into BOTH live builds (inline options carry no
// scope, so this default wins) AND rehydrated builds (hydrate → cache.build →
// defaultMutationOptions), so a restored mutation serializes identically to a live
// one — proven by the offline create+edit e2e.
const OFFLINE_QUEUE_SCOPE = { id: "web-ui-offline-mutation-queue" } as const;

export function registerMutationDefaults(queryClient: QueryClient, transport: Transport): void {
	const listKey = listTodosQueryKey(transport);

	queryClient.setMutationDefaults(CREATE_TODO_KEY, {
		...createTodoMutation(transport),
		scope: OFFLINE_QUEUE_SCOPE,
		onSettled: () => settleInvalidate(queryClient, [listKey]),
	});

	queryClient.setMutationDefaults(TOGGLE_TODO_KEY, {
		...updateTodoMutation(transport),
		scope: OFFLINE_QUEUE_SCOPE,
		onSettled: (_data, _err, vars: UpdateTodoVars) =>
			settleInvalidate(queryClient, [listKey, todoQueryKey(transport, vars.id)]),
	});

	queryClient.setMutationDefaults(EDIT_TODO_KEY, {
		...updateTodoMutation(transport),
		scope: OFFLINE_QUEUE_SCOPE,
		onSettled: (_data, _err, vars: UpdateTodoVars) =>
			settleInvalidate(queryClient, [todoQueryKey(transport, vars.id)]),
	});

	queryClient.setMutationDefaults(DELETE_TODO_KEY, {
		...deleteTodoMutation(transport),
		scope: OFFLINE_QUEUE_SCOPE,
		onSuccess: (_data, vars) => {
			queryClient.removeQueries({ queryKey: todoQueryKey(transport, vars.id) });
		},
		onSettled: () => settleInvalidate(queryClient, [listKey]),
	});
}
