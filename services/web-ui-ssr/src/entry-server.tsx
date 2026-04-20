import { renderToStream } from "solid-js/web";
import { App } from "./app";

export function render(url: string) {
	const { readable, writable } = new TransformStream();
	const stream = renderToStream(() => <App url={url} />);
	stream.pipeTo(writable);
	return readable;
}
