import path from "node:path";
import tseslint from "typescript-eslint";
import baseConfigs from "./base.ts";

const rootDir = path.resolve(import.meta.dirname, "../..");

export default [
	...baseConfigs,

	// ─── typescript-eslint: strict type-checked rules only ────────────
	// Uses projectService for automatic tsconfig discovery per file.
	// Only includes rules that require the TypeScript type-checker —
	// syntax-only rules are already covered by Biome.
	...tseslint.configs.strictTypeCheckedOnly,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: rootDir,
			},
		},
		rules: {
			// Disable rules already covered by Biome
			"no-var": "off", // biome: noVar
			"prefer-const": "off", // biome: useConst
			"@typescript-eslint/only-throw-error": "off", // biome: useThrowOnlyError
			"@typescript-eslint/require-await": "off", // biome: useAwait
			"@typescript-eslint/no-implied-eval": "off", // biome: noImpliedEval
		},
	},
];
