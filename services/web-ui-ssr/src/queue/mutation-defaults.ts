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
export function registerMutationDefaults(queryClient: QueryClient, transport: Transport): void {
	const listKey = listTodosQueryKey(transport);

	queryClient.setMutationDefaults(CREATE_TODO_KEY, {
		...createTodoMutation(transport),
		onSettled: () => settleInvalidate(queryClient, [listKey]),
	});

	queryClient.setMutationDefaults(TOGGLE_TODO_KEY, {
		...updateTodoMutation(transport),
		onSettled: (_data, _err, vars: UpdateTodoVars) =>
			settleInvalidate(queryClient, [listKey, todoQueryKey(transport, vars.id)]),
	});

	queryClient.setMutationDefaults(EDIT_TODO_KEY, {
		...updateTodoMutation(transport),
		onSettled: (_data, _err, vars: UpdateTodoVars) =>
			settleInvalidate(queryClient, [todoQueryKey(transport, vars.id)]),
	});

	queryClient.setMutationDefaults(DELETE_TODO_KEY, {
		...deleteTodoMutation(transport),
		onSuccess: (_data, vars) => {
			queryClient.removeQueries({ queryKey: todoQueryKey(transport, vars.id) });
		},
		onSettled: () => settleInvalidate(queryClient, [listKey]),
	});
}
