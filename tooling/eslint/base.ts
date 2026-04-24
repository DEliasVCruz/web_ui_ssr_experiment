import vanillaExtract from "@antebudimir/eslint-plugin-vanilla-extract";
import tanstackQuery from "@tanstack/eslint-plugin-query";
import { globalIgnores } from "eslint/config";
import solid from "eslint-plugin-solid";
import tseslint from "typescript-eslint";

// ─── Global ignores ───────────────────────────────────────────────
const ignores = globalIgnores([
	"**/node_modules/**",
	"**/dist/**",
	"**/build/**",
	"packages/rpc/gen/**",
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

// ─── eslint-plugin-vanilla-extract: CSS-in-TS style rules ─────────
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- plugin config object is untyped
const vanillaExtractRecommended: Record<string, unknown> = vanillaExtract.configs.recommended;
const vanillaExtractConfig = {
	files: ["**/*.css.ts"],
	...vanillaExtractRecommended,
	rules: {
		...(vanillaExtractRecommended.rules as Record<string, unknown>),
		"vanilla-extract/no-px-unit": ["warn", { allow: ["border", "borderBlockEnd", "boxShadow"] }],
		"vanilla-extract/no-unitless-values": "error",
		"vanilla-extract/prefer-logical-properties": "error",
	},
};

export default [
	ignores,
	tseslint.configs.base,
	solidConfig,
	...tanstackQuery.configs["flat/recommended-strict"],
	vanillaExtractConfig,
];
