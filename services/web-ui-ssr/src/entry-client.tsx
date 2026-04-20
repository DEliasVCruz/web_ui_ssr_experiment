import { hydrate } from "solid-js/web";
import { App } from "./app";

const root = document.getElementById("app");
if (root) {
	hydrate(() => <App />, root);
}
