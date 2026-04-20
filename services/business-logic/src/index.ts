import { serve } from "bun";
import app from "./app";

const DEFAULT_PORT = 3001;
const port = Number(process.env.PORT) || DEFAULT_PORT;

serve({
	port,
	fetch: app.fetch,
});
