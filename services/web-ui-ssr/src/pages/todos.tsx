import { Meta, Title } from "@solidjs/meta";

export default function Todos() {
	return (
		<>
			<Title>Todos | Web UI SSR</Title>
			<Meta name="description" content="TODO list" />
			<h1>Todos</h1>
			<p>TODO list will be wired up with TanStack Query and connect-es.</p>
		</>
	);
}
