import { MetaProvider } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import Layout from "./layout";
import Home from "./pages/home";
import Todos from "./pages/todos";

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
