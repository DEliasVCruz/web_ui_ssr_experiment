import { Meta, Title } from "@solidjs/meta";
import { container, heading } from "./shared.styles";

export default function Home() {
	return (
		<div class={container}>
			<Title>Home | Web UI SSR</Title>
			<Meta name="description" content="Home page of the Web UI SSR experiment" />
			<h1 class={heading}>Home</h1>
			<p>Welcome to the Web UI SSR experiment.</p>
		</div>
	);
}
