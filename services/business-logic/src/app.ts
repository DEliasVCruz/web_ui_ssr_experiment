import { cors as connectCors, createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { TodoService } from "@web-ui-poc/rpc/gen/todo/v1/todo_pb";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { todoServiceImpl } from "./todo-service";

const router = createConnectRouter();
router.service(TodoService, todoServiceImpl);

const fetchHandlers = router.handlers.map((handler) => ({
	requestPath: handler.requestPath,
	fetch: createFetchHandler(handler),
}));

const app = new Hono();

app.use(
	"/*",
	cors({
		origin: "*",
		allowMethods: connectCors.allowedMethods as string[],
		allowHeaders: connectCors.allowedHeaders as string[],
		exposeHeaders: connectCors.exposedHeaders as string[],
	}),
);

app.get("/health", (context) => context.json({ status: "ok" }));

const HTTP_NOT_FOUND = 404;

app.all("/todo.v1.TodoService/*", (context) => {
	const url = new URL(context.req.url);
	const handler = fetchHandlers.find((h) => url.pathname === h.requestPath);
	if (!handler) {
		return context.json({ error: "not found" }, HTTP_NOT_FOUND);
	}
	return handler.fetch(context.req.raw);
});

export default app;
