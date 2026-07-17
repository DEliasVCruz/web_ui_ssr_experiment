// dependency-cruiser — declarative module-boundary rules for the TypeScript
// workspace (bun workspaces, no Nx). Encodes DEPENDENCY-DIRECTION invariants that
// the rest of the hygiene stack does NOT cover:
//   * syncpack / sherif  → dependency-version consistency across the workspace
//   * knip               → unused files / exports / dependencies (dead code)
//   * ast-grep (rules/)  → structural code patterns (incl. WHERE a Connect
//                          transport may be constructed)
//   * strict tsconfig / biome / eslint → type & style discipline
// This file owns exactly one axis: which module may import which. See
// docs/architecture-boundaries.md for the boundary map + generated graph.
//
// Run standalone (CI tier):  bun run lint:boundaries   (→ depcruise ...)
// Generated / vendored trees are never analysed (options.doNotFollow +
// options.exclude below); the same trees are gitignored and skipped by every
// other guardrail.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			comment:
				"A cycle in the import graph means two+ modules cannot be understood, " +
				"tested, or built in isolation. Nothing here legitimately needs one.",
			severity: "error",
			from: {},
			to: { circular: true },
		},
		{
			name: "no-orphans",
			comment:
				"An orphan (imported by nothing, importing nothing reachable) is usually " +
				"dead code or a wiring mistake. Files loaded by convention rather than by a " +
				"static import — build entry points, the generated TanStack route tree, test " +
				"specs, ambient type/config files — are exempt via pathNot.",
			severity: "error",
			from: {
				orphan: true,
				pathNot: [
					// Build / runtime entry points (loaded by the bundler or Bun, not imported)
					"services/web-ui-ssr/src/index\\.ts$",
					"services/web-ui-ssr/src/entry-(server|client)\\.tsx$",
					// Generated TanStack Router route tree (loaded by convention)
					"\\.gen\\.ts$",
					// Standalone CLI scripts (run directly via `bun run scripts/…`,
					// never statically imported), if any module adds a scripts/ dir.
					"/scripts/",
					// Test specs (entry points for the test runner)
					"\\.(test|spec)\\.[jt]sx?$",
					// Tool config files loaded by convention (postcss.config.cjs,
					// rsbuild.config.ts, panda.config.ts, playwright.config.ts, …)
					"\\.config\\.[cm]?[jt]s$",
					// Ambient declaration files
					"\\.d\\.ts$",
				],
			},
			to: {},
		},
		{
			name: "services-isolated",
			comment:
				"Services must not import each other's source. Each service is an " +
				"independently deployable unit; cross-service coupling belongs behind the " +
				"RPC boundary (packages/rpc), not a source import.",
			severity: "error",
			from: { path: "^services/([^/]+)/" },
			to: {
				path: "^services/([^/]+)/",
				pathNot: "^services/$1/",
			},
		},
		{
			name: "packages-are-leaves",
			comment:
				"packages/** are leaf libraries (packages/rpc is the generated RPC " +
				"contract). A package importing a service inverts the dependency arrow: " +
				"the shared contract would depend on a consumer.",
			severity: "error",
			from: { path: "^packages/" },
			to: { path: "^services/" },
		},
		{
			name: "no-e2e-into-src",
			comment:
				"Playwright e2e specs/fixtures are test-only. If production src/ imports " +
				"from e2e/, test code (and its heavier test deps) leaks into the shipped bundle.",
			severity: "error",
			from: { path: "^services/[^/]+/src/" },
			to: { path: "^services/[^/]+/e2e/" },
		},
	],
	options: {
		// Only follow into hand-written first-party source. Everything below is
		// generated, vendored, or build output — never a boundary we own.
		doNotFollow: {
			path: [
				"node_modules",
				"packages/rpc/gen",
				"services/business-logic-java/generated-sources",
				"styled-system",
			],
		},
		exclude: {
			path: [
				"node_modules",
				"\\bdist\\b",
				"\\btarget\\b",
				"packages/rpc/gen",
				"generated-sources",
				"styled-system",
				"routeTree\\.gen\\.ts$",
			],
		},
		tsConfig: { fileName: "tsconfig.json" },
		tsPreCompilationDeps: true,
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default", "types"],
			extensions: [".js", ".jsx", ".ts", ".tsx", ".d.ts"],
		},
		reporterOptions: {
			dot: { collapsePattern: "node_modules/(?:@[^/]+/[^/]+|[^/]+)" },
		},
	},
};
