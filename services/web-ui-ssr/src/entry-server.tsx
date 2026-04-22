import { dehydrate } from "@tanstack/solid-query";
import { getAssets, renderToStream } from "solid-js/web";
import { App } from "./app";
import { prefetchTodo, prefetchTodos } from "./queries/todos";
import { createQueryClient } from "./query-client";
import { createServerTransport } from "./transport";

interface RenderResult {
	readable: ReadableStream<Uint8Array>;
	headTags: Promise<string>;
	dehydratedState: string;
}

export async function render(url: string): Promise<RenderResult> {
	const { readable, writable } = new TransformStream();

	const queryClient = createQueryClient();
	const transport = createServerTransport();

	// Prefetch data before rendering so components see populated cache during SSR
	await prefetchForRoute(url, queryClient, transport);
	const dehydratedState = JSON.stringify(dehydrate(queryClient));

	let resolveHead!: (tags: string) => void;
	let rejectHead!: (err: unknown) => void;
	const headTags = new Promise<string>((resolve, reject) => {
		resolveHead = resolve;
		rejectHead = reject;
	});

	const stream = renderToStream(() => <App url={url} queryClient={queryClient} />, {
		onCompleteShell() {
			resolveHead(getAssets());
		},
	});

	(stream.pipeTo(writable) as unknown as Promise<void>).catch(rejectHead);
	return { readable, headTags, dehydratedState };
}

async function prefetchForRoute(
	url: string,
	queryClient: ReturnType<typeof createQueryClient>,
	transport: ReturnType<typeof createServerTransport>,
) {
	const { pathname } = new URL(url, "http://localhost");

	if (pathname === "/todos") {
		await prefetchTodos(queryClient, transport);
	}

	const todoDetailMatch = pathname.match(/^\/todos\/([^/]+)$/);
	if (todoDetailMatch) {
		await prefetchTodo(queryClient, transport, todoDetailMatch[1]);
	}
}
