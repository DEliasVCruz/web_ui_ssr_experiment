import { MetaProvider } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import type { QueryClient } from "@tanstack/solid-query";
import { QueryClientProvider } from "@tanstack/solid-query";
import { lazy } from "solid-js";
import Layout from "./layout";

const Home = lazy(() => import("./pages/home"));
const Todos = lazy(() => import("./pages/todos"));
const TodoDetail = lazy(() => import("./pages/todo-detail"));

export function App(props: { url?: string; queryClient: QueryClient }) {
	return (
		<QueryClientProvider client={props.queryClient}>
			<MetaProvider>
				<Router url={props.url} root={Layout}>
					<Route path="/" component={Home} />
					<Route path="/todos" component={Todos} />
					<Route path="/todos/:id" component={TodoDetail} />
				</Router>
			</MetaProvider>
		</QueryClientProvider>
	);
}
