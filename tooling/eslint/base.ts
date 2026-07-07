import path from "node:path";
import pandacss from "@pandacss/eslint-plugin";
import tanstackQuery from "@tanstack/eslint-plugin-query";
import tanstackRouter from "@tanstack/eslint-plugin-router";
import { globalIgnores } from "eslint/config";
import solid from "eslint-plugin-solid";
import tseslint from "typescript-eslint";

// ─── Global ignores ───────────────────────────────────────────────
const ignores = globalIgnores([
	"**/node_modules/**",
	"**/dist/**",
	"**/build/**",
	"packages/rpc/gen/**",
	"**/styled-system/**",
]);

// ─── TypeScript parser + plugin (no rules, needed by solid plugin) ─

// ─── eslint-plugin-solid: Solid.js reactivity correctness ─────────
const solidConfig = {
	files: ["**/*.{ts,tsx}"],
	...solid.configs["flat/typescript"],
	rules: {
		"solid/components-return-once": "error",
		"solid/reactivity": "error",
		"solid/event-handlers": "error",
		"solid/imports": "error",
		"solid/style-prop": "error",
		"solid/no-react-deps": "error",
		"solid/self-closing-comp": "error",
		"solid/no-array-handlers": "error",
		"solid/no-proxy-apis": "error",
		"solid/prefer-classlist": "error",
		"solid/prefer-show": "error",
		// Disable: biome covers these
		"solid/no-react-specific-props": "off",
		"solid/prefer-for": "off",
		"solid/no-destructure": "off",
	},
};

// ─── @pandacss/eslint-plugin: Panda CSS correctness (lint-only) ───
// The plugin ships only legacy (eslintrc) `configs.recommended`; wrap its
// rule set into a flat config scoped to the web-ui-ssr service source, and
// point it at that service's panda.config.ts. Biome does not lint Panda, so
// there is no rule overlap. styled-system is already globally ignored.
const pandaConfigPath = path.resolve(
	import.meta.dirname,
	"../../services/web-ui-ssr/panda.config.ts",
);
// @pandacss/eslint-plugin ships no type declarations; describe the shape used.
const pandaPlugin = pandacss as unknown as {
	configs: { recommended: { rules: Record<string, "error" | "warn" | "off"> } };
};
const pandaConfig = {
	files: ["services/web-ui-ssr/src/**/*.{ts,tsx}"],
	plugins: { "@pandacss": pandaPlugin },
	rules: {
		...pandaPlugin.configs.recommended.rules,
		// `file-not-included` misfires in this monorepo: @pandacss/eslint-plugin
		// 0.3.2 resolves a file's inclusion by making `path.relative(cwd, file)`
		// and matching it against panda's `include` globs — but `cwd` comes from
		// `ctx.config.cwd`, which panda 1.11.4 no longer populates, so it falls
		// back to `process.cwd()` (the monorepo root, since eslint runs there).
		// The relative path then carries a `services/web-ui-ssr/` prefix that the
		// service-relative `./src/**` globs can't match, flagging every styled
		// file as excluded. All src files ARE included (codegen/build/e2e prove
		// it), so this guard rule is a false positive here.
		"@pandacss/file-not-included": "off",
	},
	settings: { "@pandacss/configPath": pandaConfigPath },
};

export default [
	ignores,
	tseslint.configs.base,
	solidConfig,
	...tanstackQuery.configs["flat/recommended-strict"],
	...tanstackRouter.configs["flat/recommended"],
	pandaConfig,
];
