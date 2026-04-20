import { A } from "@solidjs/router";
import { type ParentProps, Suspense } from "solid-js";

export default function Layout(props: ParentProps) {
	return (
		<>
			<nav>
				<A href="/">Home</A>
				<A href="/todos">Todos</A>
			</nav>
			<main>
				<Suspense>{props.children}</Suspense>
			</main>
		</>
	);
}
