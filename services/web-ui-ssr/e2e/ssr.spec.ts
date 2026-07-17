import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { fetchSsrHtml, listBackendTodos, test } from "./fixtures";

// SSR assertions run against the RAW server response (not the post-hydration DOM),
// so they prove the server actually renders a full, styled, content-bearing
// document for each route.
test.describe("SSR raw HTML", () => {
	test("/ is a full HTML document with the Home title and CSS link in <head>", async () => {
		const html = await fetchSsrHtml("/");

		expect(html).toContain("<html");
		expect(html).toContain("</html>");

		const head = html.slice(html.indexOf("<head"), html.indexOf("</head>"));
		expect(head).toMatch(/<title[^>]*>Home \| Web UI SSR<\/title>/);
		expect(head).toMatch(/<link[^>]*rel="stylesheet"[^>]*href="\/static\/css\/[^"]+\.css"/);

		expect(html).toContain("Welcome to the Web UI SSR experiment");
	});

	test("/todos has the Todos title, CSS link, and server-rendered todo rows", async () => {
		const html = await fetchSsrHtml("/todos");

		const head = html.slice(html.indexOf("<head"), html.indexOf("</head>"));
		expect(head).toMatch(/<title[^>]*>Todos \| Web UI SSR<\/title>/);
		expect(head).toMatch(/rel="stylesheet"/);

		// Real <li> rows in the streamed HTML — not merely the dehydrated data blob.
		expect(html).toContain('type="checkbox"');
		expect(html).toMatch(/<a[^>]*href="\/todos\/[0-9a-f-]+"/);
		expect(html).toContain(">Delete</button>");
		// The Loading fallback must NOT be what was shipped (data was pre-loaded).
		expect(html).not.toContain("Loading todos...");

		// At least one actual backend todo title appears as row text in the SSR HTML.
		const todos = await listBackendTodos();
		const firstTodo = todos[0];
		expect(firstTodo).toBeDefined();
		if (!firstTodo) throw new Error("expected at least one backend todo");
		expect(html).toContain(firstTodo.title);
	});

	test("/todos preloads every async chunk from the build manifest in <head>", async () => {
		// The async (code-split) chunks — the todos route chunk and the arktype
		// validation chunk it depends on — must be preload-hinted from the SSR
		// head, or they are only discovered after the entry executes (a request
		// waterfall on the hydration critical path). Assert against the build
		// manifest (the runner cwd is services/web-ui-ssr; ci:e2e builds right
		// before running) so the expectation tracks the real hashed filenames.
		const manifest = JSON.parse(readFileSync("dist/web/manifest.json", "utf-8")) as {
			entries: { index: { async?: { js?: string[] } } };
		};
		const asyncChunks = manifest.entries.index.async?.js ?? [];
		expect(asyncChunks.length).toBeGreaterThan(0);

		const html = await fetchSsrHtml("/todos");
		const head = html.slice(html.indexOf("<head"), html.indexOf("</head>"));
		for (const href of asyncChunks) {
			expect(head).toMatch(
				new RegExp(`<link[^>]*rel="preload"[^>]*as="script"[^>]*href="${href}"`),
			);
		}
	});

	test("/todos/:id renders the todo's dynamic title and status badge", async () => {
		const todos = await listBackendTodos();
		const todo = todos[0];
		expect(todo).toBeDefined();
		if (!todo) throw new Error("expected at least one backend todo");

		const html = await fetchSsrHtml(`/todos/${todo.id}`);

		const head = html.slice(html.indexOf("<head"), html.indexOf("</head>"));
		expect(head).toContain(`${todo.title} | Web UI SSR`);
		expect(head).toMatch(/rel="stylesheet"/);

		expect(html).toContain("Back to Todos");
		expect(html).toMatch(/Completed|Pending/);
	});
});
