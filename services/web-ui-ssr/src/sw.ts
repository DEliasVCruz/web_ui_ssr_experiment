// Service worker entry for web-ui-ssr — PRODUCTION-ONLY.
//
// Built by @serwist/webpack-plugin's InjectManifest (see rsbuild.config.ts), which
// compiles this file with a child compiler and replaces `self.__SW_MANIFEST` with
// the content-hashed precache list for the *same* web build whose manifest.json the
// SSR head reads. It is emitted to dist/web/sw.js and served at /sw.js (root scope)
// by the prod server; entry-client.tsx registers it client-side, prod-only.
//
// The caching strategies, lifecycle flags, backend-origin exclusion, network
// timeout, and expiration bounds all live in ./sw-config (where they are pinned by
// unit tests — Serwist configs are data); this entry only binds them to the worker
// globals. The design rationale (1w9.1 §Q1–Q3) is documented on buildSwOptions.
//
// Type environment: this module runs in a ServiceWorkerGlobalScope, NOT a DOM
// Window — it is excluded from tsconfig.json and type-checked via tsconfig.sw.json
// (lib: ["WebWorker"]). Do not import DOM-only globals here.
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";
import { buildSwOptions } from "./sw-config";

declare global {
	interface WorkerGlobalScope extends SerwistGlobalConfig {
		// Injected at build time by @serwist/webpack-plugin (InjectManifest). Left
		// `undefined` in dev builds (disablePrecacheManifest), hence the union.
		// biome-ignore lint/style/useNamingConvention: name must match the injection point the plugin replaces (self.__SW_MANIFEST)
		__SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
	}
}

declare const self: ServiceWorkerGlobalScope;

// `?? []` satisfies exactOptionalPropertyTypes (the injected manifest is typed
// `... | undefined` for dev builds); prod always has it injected by InjectManifest.
const serwist = new Serwist(buildSwOptions(self.__SW_MANIFEST ?? []));

serwist.addEventListeners();
