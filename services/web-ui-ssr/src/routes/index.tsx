import { createFileRoute } from "@tanstack/solid-router";
import { container, heading } from "../pages/shared.styles";

export const Route = createFileRoute("/")({
	head: () => ({
		meta: [
			{ title: "Home | Web UI SSR" },
			{ name: "description", content: "Home page of the Web UI SSR experiment" },
		],
	}),
	component: () => (
		<div class={container}>
			<h1 class={heading}>Home</h1>
			<p>Welcome to the Web UI SSR experiment.</p>
		</div>
	),
});
