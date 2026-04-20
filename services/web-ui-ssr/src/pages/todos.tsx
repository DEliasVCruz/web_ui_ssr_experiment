import { Meta, Title } from "@solidjs/meta";
import { container } from "./shared.css";
import { heading } from "./todos.css";

export default function Todos() {
	return (
		<div class={container}>
			<Title>Todos | Web UI SSR</Title>
			<Meta name="description" content="TODO list" />
			<h1 class={heading}>Todos</h1>
			<p>TODO list will be wired up with TanStack Query and connect-es.</p>
		</div>
	);
}
