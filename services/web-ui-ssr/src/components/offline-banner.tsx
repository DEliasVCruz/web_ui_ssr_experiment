import { createSignal, onCleanup, onMount, Show } from "solid-js";
import {
	offlineBanner,
	offlineError,
	offlineErrorHeading,
	staleIndicator,
} from "../pages/offline.styles";

// Offline UI (task 1w9.4 §4.6). navigator.onLine is honest only about "attached
// to a network," not "internet reachable" — acceptable here; the queue's real
// backstop is the mutation pausing, not this banner.

/**
 * App-shell offline banner, driven by `navigator.onLine` + online/offline
 * listeners. SSR-safe like the Toaster region: the initial signal is `true`
 * (online) so the server render (no `navigator`) and the client's first hydration
 * render agree — nothing rendered, no mismatch. `onMount` runs client-only, reads
 * the real status, and subscribes to connectivity changes.
 */
export function OfflineBanner() {
	const [online, setOnline] = createSignal(true);
	onMount(() => {
		setOnline(navigator.onLine);
		const goOnline = () => setOnline(true);
		const goOffline = () => setOnline(false);
		window.addEventListener("online", goOnline);
		window.addEventListener("offline", goOffline);
		onCleanup(() => {
			window.removeEventListener("online", goOnline);
			window.removeEventListener("offline", goOffline);
		});
	});
	return (
		<Show when={!online()}>
			<div class={offlineBanner} role="status" aria-live="polite">
				You’re offline. Changes are saved and will sync when you reconnect.
			</div>
		</Show>
	);
}

/**
 * Inline stale-data indicator (1w9.3 review F2). Rendered alongside visible data
 * when a background refetch has failed (`data && isError`), so we keep showing the
 * saved data with an honest badge instead of replacing it with an error screen.
 */
export function StaleIndicator() {
	return (
		<p class={staleIndicator} role="status" aria-live="polite">
			Showing saved data — reconnecting…
		</p>
	);
}

/**
 * Designed route-level error/offline message (1w9.3 review F1), used as the
 * routes' `errorComponent` in place of TanStack's generic error screen — e.g.
 * navigating offline to a route whose data was never cached.
 */
export function OfflineRouteError() {
	return (
		<div class={offlineError}>
			<h1 class={offlineErrorHeading}>This page isn’t available offline</h1>
			<p>
				We couldn’t load this content. If you’re offline, reconnect and try again — anything you’ve
				changed is saved and will sync automatically.
			</p>
		</div>
	);
}
