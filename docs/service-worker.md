# Service worker (offline assets + navigation shell)

The web-ui-ssr client ships a **production-only** service worker (task
`web_ui_ssr_experiment-1w9.2`) that precaches the build's assets and serves a
last-good navigation shell offline. It is one half of the offline-tolerant epic
(`1w9`); the **data** offline story (browse cached todos, queue writes) is owned
entirely by the TanStack query persister + mutation queue (`1w9.3`/`1w9.4`), **not**
the service worker. The two never overlap — see the exclusion rule below.

Design of record: Basic Memory note
`main/web-ui/architecture/offline-support-design-1w9-sw-persistence-queue-client-ids`
(§Q1–Q3, Q5). This doc is the implementation summary.

## What it caches

Built with [Serwist](https://serwist.pages.dev) v9. Entry: `src/sw.ts`; the
strategy/lifecycle configuration is data in `src/sw-config.ts`, pinned by unit
tests (`src/sw-config.test.ts` — matchers, backend exclusion, timeout, bounds).

| Request                          | Strategy      | Cache      | Bounds |
| -------------------------------- | ------------- | ---------- | ------ |
| Build assets (hashed JS/CSS)     | Precache      | (precache) | manifest-managed |
| Same-origin images               | CacheFirst    | `images`   | 100 entries / 30 d |
| Same-origin fonts                | CacheFirst    | `fonts`    | 100 entries / 30 d |
| Full-document navigations        | NetworkFirst (4 s timeout) | `pages` | 50 entries / 7 d |
| Navigation miss, offline         | Precache fallback → `/offline` | (precache) | — |

- **Navigations are NetworkFirst**, caching the **real last-good SSR response per
  visited URL**. That cached HTML carries its own dehydrated query state, so an
  offline `hydrate()` matches the served bytes exactly → **hydration stays
  byte-clean offline**. The persisted IndexedDB cache reconciles *after* hydration
  as an ordinary reactive update, never during it.
- **`networkTimeoutSeconds: 4` on navigations**: NetworkFirst only falls back to
  cache on a *hard* network rejection — without the timeout, a lie-fi/slow network
  hangs the navigation forever and the cached page never serves. 4 s gives the live
  SSR a fair chance without leaving the user on a blank tab.
- **Every runtime cache is bounded** (`ExpirationPlugin` with `maxEntries`,
  `maxAgeSeconds`, and `purgeOnQuotaError: true`): unbounded caches grow forever
  (`pages` would store every visited URL's full HTML — distinct query strings are
  distinct entries), and browser quota eviction, when it strikes, can wipe the
  whole origin **including the query-persistence IndexedDB**. With
  `purgeOnQuotaError` these caches are the first sacrifice under quota pressure
  instead of the trigger for origin-wide eviction. `pages` is capped at 7 d to
  match the persister's ~7 d `maxAge` (an HTML shell older than the data it would
  reconcile against has no value).
- **Never-visited routes offline** fall back to a **precached minimal offline
  shell** (`/offline`, served by the prod server in `src/index.ts`). The shell has
  the same content-hashed CSS/scripts as a real page but an **empty body and no
  dehydrated state**, plus a `data-offline-shell` marker on `<html>`. `entry-client`
  reads that marker and **client-renders** (instead of hydrating), so the route
  loader paints from the persisted query cache. One client entry, one branch — no
  separate offline build.

## What it deliberately does NOT touch

**No rule matches the business-logic origin** (`…/todo.v1.TodoService/*`) — neither
the binary-POST mutations nor the binary-GET reads. Reasons (design §Q2):

1. Two offline caches for the same data would **desync** — the persister already
   owns per-query staleness, `offlineFirst` loads, and mutation-driven invalidation.
2. A SW-served RPC is not a real call, so it would **corrupt the wide-event
   `rpc_count`/`traceparent` model** (iq2.4).

Because the backend is a **different origin** (`:3001` vs the app's `:3000`), those
RPCs are cross-origin fetches the SW simply lets pass through — no denylist needed,
just no runtime-caching rule for that origin.

## Lifecycle & registration

- `skipWaiting: true` + `clientsClaim: true` + `navigationPreload: true` (§Q3).
  Single-window app, no cross-tab data contract → immediate activation is desirable.
- **Accepted tradeoff — stale open tabs across a deploy**: with `skipWaiting`, a
  new SW can activate mid-session in an already-open tab. That tab's page still
  references the *old* build's hashed lazy chunks, which the new SW's precache no
  longer holds — so a not-yet-loaded async chunk could 404 offline (online it still
  fetches fine from `/static`, which serves both old and new files until the server
  itself is redeployed). Today this is additionally (and accidentally) mitigated by
  the SSR head preloading **all** async chunks up front, so by the time a new SW
  takes over, the old chunks are already in the HTTP cache. We accept this window
  rather than adding update-prompt machinery (`controllerchange` → reload toast);
  if the app grows real mid-session deploy sensitivity, that is the upgrade path.
- **Content-hashed filenames = free precache invalidation.** A new deploy → new
  hashes → new manifest → new `sw.js` bytes → the browser updates the SW → Serwist
  drops stale precache entries. The SSR head's preload/script hints reference the
  same hashed URLs that are precached (same build), so they resolve from precache
  offline.
- Registered in `entry-client.tsx` via `@serwist/window`: **prod-only**
  (`NODE_ENV === "production"`), **feature-detected** (`"serviceWorker" in
  navigator`), on `window` **load** (off the hydration-critical path). Import-safe
  under SSR — the module is client-only.

## Build wiring

`@serwist/webpack-plugin`'s `InjectManifest` is added via `tools.rspack` in
`rsbuild.config.ts`, scoped to the **`web` environment in production only** (the
`server` build must never carry SW code; dev uses rsbuild HMR, which a SW would
fight). It compiles `src/sw.ts`, injects `self.__SW_MANIFEST` with this build's
precache list, and emits `dist/web/sw.js`. The prod server serves it at **`/sw.js`
(root scope)** so it can control the whole origin.

`src/sw.ts` runs in a `ServiceWorkerGlobalScope`, so it is excluded from
`tsconfig.json` (DOM lib) and type-checked via **`tsconfig.sw.json`** (WebWorker
lib), chained into the `typecheck` script.

## e2e & the secure-context caveat

SW registration needs a **secure context**. The e2e browser reaches the app over
plain HTTP at `host.docker.internal:<port>`, so `playwright:up` starts the shared
headless container with
`--unsafely-treat-insecure-origin-as-secure=*.docker.internal` (a hostname wildcard
matching any ephemeral port) + `--user-data-dir`. `e2e/sw.spec.ts` **skips only
when `navigator.serviceWorker` is missing** (insecure context — the flag not
honored, old headless, Playwright #22944); under a secure context it passively
awaits `navigator.serviceWorker.ready`, so the **production registration in
entry-client is what's under test** — a removed registration, an unserved
`/sw.js`, or a broken worker all FAIL the spec rather than skip. The bulk of the
offline suite (`persistence.spec.ts` and the `1w9.5` data-offline tests) needs **no
service worker** — it drives `context.setOffline(true)` over plain HTTP.
