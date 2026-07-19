import { defineConfig } from "@playwright/test";

// Navigations run inside the CDP browser container, which reaches the host as
// `host.docker.internal`. The prod server binds 0.0.0.0:3000, so the container
// hits it there. Overridable for other topologies via E2E_BASE_URL.
// Destructured from process.env with defaults: dot access is barred by
// noPropertyAccessFromIndexSignature (TS4111) and bracket access by biome's
// useLiteralKeys; destructuring is exempt from both. `CI` is presence-checked,
// so no default (undefined = not in CI).
const { E2E_BASE_URL = "http://host.docker.internal:3000", CI } = process.env;
const BASE_URL = E2E_BASE_URL;

export default defineConfig({
	testDir: "./e2e",
	// One worker, sequential: a single shared CDP browser and CRUD tests that
	// mutate real backend state.
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(CI),
	// The CRUD/dialog/toast write-path tests hit the real backend over the
	// network and have flaked once on a 30s toBeVisible timeout (passed on
	// rerun). Retry to absorb transient network/CDP jitter.
	retries: CI ? 2 : 1,
	timeout: 30_000,
	expect: { timeout: 15_000 },
	// Persist a report to disk regardless of pass/fail: `nix run .#ci-e2e`
	// swallows stdout, so a failing run needs an on-disk artifact to diagnose from.
	// Paths are relative to this config's dir (services/web-ui-ssr); both are gitignored.
	reporter: [
		["list"],
		["junit", { outputFile: "test-results/junit.xml" }],
		["html", { open: "never", outputFolder: "playwright-report" }],
	],
	use: {
		// biome-ignore lint/style/useNamingConvention: `baseURL` is Playwright's config key
		baseURL: BASE_URL,
		trace: "off",
		screenshot: "off",
		video: "off",
	},
});
