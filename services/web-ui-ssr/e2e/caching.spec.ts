import { expect } from "@playwright/test";
import { fetchSsrHtml, RAW_BASE_URL, test } from "./fixtures";

// Cache-Control policy (mid-deploy stale-tab mitigation, 1w9.2 F5 — low-risk half).
// Content-hashed /static assets are cached hard + immutable (their bytes never change
// for a URL); revalidatable resources (the SSR document, sw.js) are NOT, so a redeploy
// is picked up on the next load. These are pure host-side fetches — no browser needed,
// but they use the shared `test` so they run inside the same e2e project/server.
const HTTP_OK = 200;

test.describe("static asset caching headers", () => {
	test("content-hashed /static assets are cached immutable for a year", async () => {
		// Pull a real hashed asset URL out of the SSR head (CSS/JS <link>/<script>).
		const html = await fetchSsrHtml("/todos");
		const match = /\/static\/[^"']+\.(?:js|css)/.exec(html);
		expect(match, "the SSR head should reference a hashed /static asset").not.toBeNull();

		const res = await fetch(`${RAW_BASE_URL}${match?.[0] ?? ""}`);
		expect(res.status).toBe(HTTP_OK);
		const cacheControl = res.headers.get("cache-control") ?? "";
		expect(cacheControl).toContain("immutable");
		expect(cacheControl).toContain("max-age=31536000");
	});

	test("the SSR document is NOT immutably cached (stays revalidated for redeploys)", async () => {
		const res = await fetch(`${RAW_BASE_URL}/todos`);
		expect(res.status).toBe(HTTP_OK);
		expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
	});

	test("the service worker is NOT immutably cached", async () => {
		const res = await fetch(`${RAW_BASE_URL}/sw.js`);
		expect(res.status).toBe(HTTP_OK);
		expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
	});
});
