import { dehydrate } from "@tanstack/solid-query";
import { generateHydrationScript, getAssets, renderToStream } from "solid-js/web";
import { App } from "./app";
import { prefetchTodo, prefetchTodos } from "./queries/todos";
import { createQueryClient } from "./query-client";
import { createServerTransport } from "./transport";

/** Initialises _$HY before SSR inline scripts in the body run. */
const hydrationScript = generateHydrationScript();

interface RenderResult {
	readable: ReadableStream<Uint8Array>;
	headTags: Promise<string>;
	hydrationScript: string;
	dehydratedState: string;
}

export async function render(url: string): Promise<RenderResult> {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

	const queryClient = createQueryClient();
	const transport = createServerTransport();

	// Prefetch data before rendering so components see populated cache during SSR
	await prefetchForRoute(url, queryClient, transport);
	const dehydratedState = JSON.stringify(dehydrate(queryClient), (_key, value: unknown) =>
		typeof value === "bigint" ? `__bigint__${String(value)}` : value,
	);

	let resolveHead!: (tags: string) => void;
	let rejectHead!: (err: unknown) => void;
	const headTags = new Promise<string>((resolve, reject) => {
		resolveHead = resolve;
		rejectHead = reject;
	});

	const stream = renderToStream(
		() => <App url={url} queryClient={queryClient} transport={transport} />,
		{
			onCompleteShell() {
				resolveHead(getAssets());
			},
		},
	);

	// eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- solid's renderToStream.pipeTo is typed as void but returns a Promise at runtime
	const pipePromise = stream.pipeTo(writable) as unknown as Promise<void>;
	pipePromise.catch(rejectHead);
	return { readable, headTags, hydrationScript, dehydratedState };
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
