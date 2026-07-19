import { type Browser, test as base, chromium, expect, type Page } from "@playwright/test";

const HTTP_OK = 200;

// The browser is a headless Chromium running in a podman container, exposing CDP
// on this endpoint. Playwright connects to it over CDP instead of launching a
// local browser (see playwright.config.ts / `nix run .#playwright-up`).
// Destructured with defaults: dot access on process.env is barred by
// noPropertyAccessFromIndexSignature (TS4111) and bracket access by biome's
// useLiteralKeys; destructuring-with-default is exempt from both.
const { CDP_ENDPOINT = "http://localhost:9222" } = process.env;

// URLs reachable from the Playwright *runner* (the host), used for raw HTTP
// assertions. The in-container browser reaches the app via baseURL
// (host.docker.internal:3000); the runner on macOS cannot resolve that name, so
// host-side fetches target localhost instead.
const { E2E_RAW_BASE_URL = "http://localhost:3000", E2E_BACKEND_URL = "http://localhost:3001" } =
	process.env;
export const RAW_BASE_URL = E2E_RAW_BASE_URL;
export const BACKEND_URL = E2E_BACKEND_URL;

// The Add-todo input, server-rendered on /todos. Used as the hydration probe:
// once Solid attaches its delegated `onInput` handler the app is interactive.
export const ADD_INPUT_SELECTOR = 'input[placeholder="What needs to be done?"]';

interface CdpWorkerFixtures {
	cdpBrowser: Browser;
}

export const test = base.extend<object, CdpWorkerFixtures>({
	cdpBrowser: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an empty destructuring pattern to declare a fixture with no dependencies
		async ({}, use) => {
			const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
			await use(browser);
			await browser.close();
		},
		{ scope: "worker" },
	],
	// Fresh, isolated context per test from the shared CDP browser.
	context: async ({ cdpBrowser }, use) => {
		const ctx = await cdpBrowser.newContext();
		await use(ctx);
		await ctx.close();
	},
	page: async ({ context }, use) => {
		const page = await context.newPage();
		await use(page);
		await page.close();
	},
});

/**
 * Reads the raw SSR HTML for a route from the host-reachable server. Deliberately
 * uses `fetch` (not the browser) so assertions run against the exact bytes the
 * server streams, independent of client hydration.
 */
export async function fetchSsrHtml(path: string): Promise<string> {
	const res = await fetch(`${RAW_BASE_URL}${path}`);
	expect(res.status).toBe(HTTP_OK);
	return res.text();
}

export interface BackendTodo {
	id: string;
	title: string;
	completed?: boolean;
	// Present only when the todo carries details. Over Connect JSON an unset
	// (never-set / NULL) details field is omitted from the response entirely,
	// while a set value — including the empty string that a clear writes — is
	// serialised. So `undefined` here means "no details field on the wire".
	details?: string;
}

/** Lists todos straight from the business-logic backend (Connect RPC over JSON). */
export async function listBackendTodos(): Promise<BackendTodo[]> {
	const res = await fetch(`${BACKEND_URL}/todo.v1.TodoService/ListTodos`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	const json = (await res.json()) as { todos?: BackendTodo[] };
	return json.todos ?? [];
}

/**
 * Creates a todo straight on the backend (Connect RPC over JSON), optionally with
 * details. Lets a spec seed exact state (e.g. a todo that already has details)
 * without driving the create UI. Over JSON, omitting `details` leaves it unset;
 * passing a string (including "") sets it.
 */
export async function createBackendTodo(title: string, details?: string): Promise<BackendTodo> {
	const body: { title: string; details?: string } = { title };
	if (details !== undefined) body.details = details;
	const res = await fetch(`${BACKEND_URL}/todo.v1.TodoService/CreateTodo`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(HTTP_OK);
	const json = (await res.json()) as { todo: BackendTodo };
	return json.todo;
}

/** Fetches a single todo from the backend by id (Connect RPC over JSON). */
export async function getBackendTodo(id: string): Promise<BackendTodo> {
	const res = await fetch(`${BACKEND_URL}/todo.v1.TodoService/GetTodo`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id }),
	});
	expect(res.status).toBe(HTTP_OK);
	const json = (await res.json()) as { todo: BackendTodo };
	return json.todo;
}

/** Deletes a todo on the backend by id, so a spec can self-clean its fixtures. */
export async function deleteBackendTodo(id: string): Promise<void> {
	const res = await fetch(`${BACKEND_URL}/todo.v1.TodoService/DeleteTodo`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id }),
	});
	expect(res.status).toBe(HTTP_OK);
}

/**
 * Waits until the client has hydrated: Solid attaches a delegated `onInput`
 * handler (the `$$input` property) to the Add input. This is the authoritative
 * "app is interactive" signal — `Object.keys(document).filter(k => k.startsWith('$$'))`
 * is a false signal in this Solid version and must not be used.
 */
export async function waitForHydration(page: Page): Promise<void> {
	const input = page.locator(ADD_INPUT_SELECTOR);
	await expect(input).toBeVisible();
	await expect
		.poll(() =>
			input.evaluate((el) => typeof (el as Element & { $$input?: unknown }).$$input === "function"),
		)
		.toBe(true);
}
