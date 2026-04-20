import { A } from "@solidjs/router";
import type { ParentProps } from "solid-js";

export default function Layout(props: ParentProps) {
	return (
		<>
			<nav>
				<A href="/">Home</A>
				<A href="/todos">Todos</A>
			</nav>
			<main>{props.children}</main>
		</>
	);
}
