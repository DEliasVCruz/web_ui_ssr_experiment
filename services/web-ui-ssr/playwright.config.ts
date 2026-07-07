import { defineConfig } from "@playwright/test";

// Navigations run inside the CDP browser container, which reaches the host as
// `host.docker.internal`. The prod server binds 0.0.0.0:3000, so the container
// hits it there. Overridable for other topologies via E2E_BASE_URL.
const BASE_URL = process.env.E2E_BASE_URL ?? "http://host.docker.internal:3000";

export default defineConfig({
	testDir: "./e2e",
	// One worker, sequential: a single shared CDP browser and CRUD tests that
	// mutate real backend state.
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	timeout: 30_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	use: {
		// biome-ignore lint/style/useNamingConvention: `baseURL` is Playwright's config key
		baseURL: BASE_URL,
		trace: "off",
		screenshot: "off",
		video: "off",
	},
});
