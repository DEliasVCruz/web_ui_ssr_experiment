import { dehydrate } from "@tanstack/solid-query";
import { getAssets, renderToStream } from "solid-js/web";
import { App } from "./app";
import { prefetchTodos } from "./queries/todos";
import { createQueryClient } from "./query-client";
import { createServerTransport } from "./transport";

interface RenderResult {
	readable: ReadableStream<Uint8Array>;
	headTags: Promise<string>;
	dehydratedState: Promise<string>;
}

export function render(url: string): RenderResult {
	const { readable, writable } = new TransformStream();

	const queryClient = createQueryClient();
	const transport = createServerTransport();

	let resolveHead!: (tags: string) => void;
	let rejectHead!: (err: unknown) => void;
	const headTags = new Promise<string>((resolve, reject) => {
		resolveHead = resolve;
		rejectHead = reject;
	});

	// Prefetch data based on URL before rendering
	const dehydratedState = prefetchForRoute(url, queryClient, transport).then(() =>
		JSON.stringify(dehydrate(queryClient)),
	);

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
}
