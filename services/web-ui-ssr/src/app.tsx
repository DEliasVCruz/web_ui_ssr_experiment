import { MetaProvider } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import { lazy } from "solid-js";
import Layout from "./layout";

const Home = lazy(() => import("./pages/home"));
const Todos = lazy(() => import("./pages/todos"));

export function App(props: { url?: string }) {
	return (
		<MetaProvider>
			<Router url={props.url} root={Layout}>
				<Route path="/" component={Home} />
				<Route path="/todos" component={Todos} />
			</Router>
		</MetaProvider>
	);
}
