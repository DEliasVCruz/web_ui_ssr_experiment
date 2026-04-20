import { getAssets, renderToStream } from "solid-js/web";
import { App } from "./app";

interface RenderResult {
	readable: ReadableStream<Uint8Array>;
	/** Resolves with the collected `<meta>`, `<title>`, etc. tags once the shell is ready. */
	headTags: Promise<string>;
}

export function render(url: string): RenderResult {
	const { readable, writable } = new TransformStream();

	let resolveHead!: (tags: string) => void;
	let rejectHead!: (err: unknown) => void;
	const headTags = new Promise<string>((resolve, reject) => {
		resolveHead = resolve;
		rejectHead = reject;
	});

	const stream = renderToStream(() => <App url={url} />, {
		onCompleteShell() {
			resolveHead(getAssets());
		},
	});

	// pipeTo returns a Promise at runtime; the mock types incorrectly declare void
	(stream.pipeTo(writable) as unknown as Promise<void>).catch(rejectHead);
	return { readable, headTags };
}
