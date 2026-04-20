import { serve } from "bun";
import app from "./app";

const port = Number(process.env.PORT) || 3001;

serve({
	port,
	fetch: app.fetch,
});

console.log(`business-logic server listening on http://localhost:${port}`);
