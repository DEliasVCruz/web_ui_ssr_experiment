/**
 * Client-only View Transitions helpers (progressive enhancement).
 *
 * `document.startViewTransition` exists only in the browser (never during SSR —
 * `document` is absent server-side) and only in supporting engines (Chromium;
 * not Firefox / older Safari). Every entry point here feature-detects and, when
 * the API is unavailable, degrades to a plain synchronous update so behaviour is
 * byte-identical where transitions can't run. All access is inside functions —
 * nothing here touches `document`/`window` at module scope, keeping SSR safe.
 *
 * Reduced motion: users who ask for less motion get NO transition at all — we
 * skip the `startViewTransition` call entirely (rather than merely zeroing the
 * CSS animation), so no snapshot/animation machinery runs for them. The router's
 * `defaultViewTransition` is likewise fed from `viewTransitionsEnabled()`.
 */

/**
 * True only in a browser that supports View Transitions AND whose user has not
 * requested reduced motion. False during SSR (no `window`/`document`), in
 * non-supporting engines, and under `prefers-reduced-motion: reduce`.
 */
export function viewTransitionsEnabled(): boolean {
	if (typeof window === "undefined" || typeof document === "undefined") return false;
	// lib.dom types `startViewTransition` as always-present; the runtime check is
	// what actually gates Firefox/older engines where it is `undefined`.
	if (typeof document.startViewTransition !== "function") return false;
	return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Runs the async `update` inside a view transition when enabled, else just calls
 * it. `update` is a promise-returning action (e.g. a solid-query
 * `invalidateQueries` whose promise resolves once the refetch has applied) — the
 * transition awaits it and captures the DOM afterwards, giving list add/remove
 * their enter/exit animation.
 */
export function withViewTransition(update: () => Promise<unknown>): void {
	if (!viewTransitionsEnabled()) {
		void update();
		return;
	}
	document.startViewTransition(async () => {
		await update();
	});
}
