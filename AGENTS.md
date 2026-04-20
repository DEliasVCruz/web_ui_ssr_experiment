# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

This is a **proof-of-concept** for the web UI SSR layer of a larger platform.
It is deliberately isolated from the rest of the platform so we can exercise
the rendering stack end-to-end and gather learnings before committing to it
at scale. The deliverable is a small TODO app that exercises every moving
part of the pipeline.

This is **not** production code and is **not** a vertical slice of the real
product. Treat it as an experiment.

## Source of truth: Basic Memory

The architectural context for this experiment lives in the **`web_ui`**
Basic Memory project. Before making non-trivial changes — especially to the
build, the SSR wiring, the RPC layer, or the service topology — read the
relevant notes.

Use the /memory-notes skill for creating and updating notes, any research
made that it's relevant and good to keep in context add with /memory-research
skill

**Always use Basic Memory for architectural context. Do not rely on prior
assumptions about how the broader platform works; this experiment is
scoped narrowly and most of the wider architecture is intentionally out
of scope here.**

## Coding rules

### Linting

**Biome**:
  - When reviewing linting errors, do not try to apply them inmediatly, always prefer checking 
    and using the autocorrection feature with `--write` and only provide direct fixes for those 
    that can not be auto resolved or that their action is `unsafe` to apply (per biome's criteria) 
    those who are unsafe review first that they don't affect the semantics of the program and if 
    they don't then prefer their solution, otherwise apply your own.
  - Warnings are to be examined and taking into account based on the full documented description
    of the rule, they should genarabily be followed unless they would increase the complexity,
    verbosity, functionality or undersatbility of the code.
  - Info messages are meant to be treated as hints of code smells, they don't need to be adressed
    necessarely but they provide a guide to stop and think if there are better paterns or
    implementations that are inline with the code practices and style of the codebase
  - Any rule notification that it's not an error or does not have a `safe` action should always be
    review and analyze first that they don't affect the semantics of the program and if 
    they don't then prefer their solution, otherwise apply your own or just ignore it.

## Task managment

Use beads as the tool for dividing, managing and cordinating task and
work https://gastownhall.github.io/beads/llms.txt. Do not mark tasks
as done unless I explecitly tell you so

## Working directory & git worktrees

You may be spawned inside a **git worktree** (a sibling directory like
`web_ui_ssr_experiment.claude-r36-…`). When that happens:

- **All file reads, edits, and writes must use paths relative to your
  current working directory** (or its absolute equivalent). Never
  hard-code or assume the main repo path
  (`web_ui_ssr_experiment/`). The worktree has its own copy of every
  tracked file; editing the main repo's files will dirty the wrong
  branch.
- Before editing any file, verify you are using the path under your
  **actual CWD** (check with `pwd` if unsure).
- `devenv.nix`, `AGENTS.md`, etc. exist in both the main repo and the
  worktree — always operate on the worktree's copy.

## Enviroment setup

You are **already running inside a devenv shell**. Do not wrap commands with
`devenv shell --`; just run them directly. The shell is managed by devenv.nix
at the repo root.

If there is some tool that you require but it's not relevant to the project,
create an ad-hoc environment:

    $ devenv -O languages.rust.enable:bool true -O packages:pkgs "mypackage mypackage2" shell -- cli args
    
When the tool that you require it's not available and it's miningfull for the project then
configure it through devenv.nix

See https://devenv.sh/ad-hoc-developer-environments/

## Committing your work

Do not auto commit commit your work wait for the user to confirm that it's ok with the changes
and then commit it ussing best practices and meaninfull messages

### Key notes

All notes live under `architecture/` in the `web_ui` project:

- `memory://web_ui/architecture/web-ui-stack` — technology choices
- `memory://web_ui/architecture/web-ui-render-pipeline` — how HTML is produced, hydrated, and styled
- `memory://web_ui/architecture/poc-service-topology` — the two-service split and Docker Compose layout
- `memory://web_ui/architecture/rpc-data-flow` — connect-es paths for SSR and post-hydration
- `memory://web_ui/architecture/web-ui-poc-scope` — what is and isn't in scope, and the learning goals

### How to use Basic Memory

- Use `search_notes` on the `web_ui` project to find relevant context by keyword.
- Use `read_note` to load a specific note by title or permalink.
- Use `build_context` with `memory://web_ui/architecture/<permalink>` to follow relations and gather connected knowledge.
- When you discover something worth recording (a decision, a gotcha, a technique that worked), write or edit a note. Prefer `edit_note` over creating duplicates.
- **Scope discipline**: only write notes that belong to this experiment. Anything about the broader platform (deployment, gateway, auth, realtime, PPR, differential serving, request lifecycle caching, etc.) goes in the `main` project, not here.

## Architecture at a glance

Two services orchestrated by Docker Compose:

1. **web-ui-ssr** — Bun + Hono rendering server. Runs SolidJS SSR via
   `renderToStream`, serves the client bundle, and calls the
   business-logic server via connect-es during SSR. Owns no data.
2. **business-logic** — Bun + Hono stub of the real backend. Exposes
   connect-es RPC endpoints. Persists data in SQLite (file mounted as
   a Docker volume).

The browser, after hydration, talks to the business-logic server
**directly** via connect-es. The rendering server is not a proxy for
post-hydration traffic.

## Stack

- **Runtime**: Bun
- **HTTP**: Hono
- **UI framework**: SolidJS (no SolidStart — SSR is wired manually)
- **Routing**: `@solidjs/router` (isomorphic, `url` prop for SSR)
- **Head management**: `@solidjs/meta` (`MetaProvider` + `renderTags()`)
- **Data**: TanStack Query via `solid-query`, dehydrated on SSR and rehydrated on the client
- **RPC**: connect-es, same generated client used on server and browser
- **Bundler**: Rsbuild (Rspack), with `web` and `node` environments in one build
- **Code splitting**: `lazy()` on route components, producing paired JS+CSS chunks; manifest-driven preload + stylesheet injection
- **Styling**: vanilla-extract (TypeScript-authored, zero-runtime CSS, extracted per chunk)
- **Data store**: SQLite (business-logic server only)
- **Orchestration**: Docker + Docker Compose

## In scope

- Manual SSR wiring on Rsbuild + Hono + Bun
- `renderToStream` + client `hydrate`
- Suspense-wrapped async data loaders calling RPC
- Dehydrate/rehydrate of TanStack Query cache via embedded state in HTML
- `lazy()` route splitting with JS+CSS chunk pairs, including vanilla-extract styles
- connect-es RPC on both the SSR and post-hydration paths
- Two-service split orchestrated by Docker Compose
- SQLite persistence on the business-logic side

## Out of scope (do not add)

Do not introduce these without an explicit request. They belong to the
broader platform and would defeat the point of keeping this experiment
narrow:

- PPR / shell caching / component render cache
- Differential serving (modern vs legacy tiers, UA detection, polyfills)
- Full request lifecycle with cache layers and `Vary` headers
- Deployment concerns (cloud provider, proxies, gateways)
- Real backend services or any reference to what the business-logic stub "really" is
- Real authentication / JWT middleware
- WebSockets / realtime transport

If you find yourself reaching for one of these to make something work,
stop and flag it — the experiment is probably asking a question we
didn't intend to ask yet.

## Working agreements

- **Read Basic Memory first.** For anything touching the render pipeline, service split, RPC, or build, skim the relevant note(s) before changing code.
- **Match the notes.** If the code diverges from a note, decide whether the code is wrong or the note is stale. Update one or the other; don't leave them inconsistent.
- **Keep the two services honest.** The rendering server must not own data or proxy post-hydration traffic. The business-logic server must be the only SQLite client.
- **Same RPC contract on both sides.** Both SSR code and browser code should import the same generated connect-es client and call the same methods.
- **Streaming requires Suspense.** Any async boundary must be under `<Suspense>` or streaming breaks.
- **Prefer small, reversible changes.** This is a learning exercise; optimize for clarity and the ability to rip things out, not for robustness.
- **Record learnings.** When you hit a surprise — something that worked, something that didn't, a gotcha in a library — write or update a note in the `web_ui` project so it isn't lost.

## Running the project

Once implemented, the expected workflow is:

```sh
docker compose up
```

This should bring up both services. The rendering server serves HTML on
its published port; the business-logic server is reachable by the
rendering server over the Compose network and by the browser via its
own published port.

## Validation checklist

Use these as acceptance signals for the POC:

- [ ] `docker compose up` starts both services cleanly
- [ ] A page request returns streamed HTML with the TODO list already populated
- [ ] The HTML contains dehydrated TanStack Query state
- [ ] Hydration does not trigger a refetch for data already present in the dehydrated state
- [ ] After hydration, mutations go browser → business-logic directly (verify via network panel: no hits to the rendering server for data)
- [ ] `lazy()` route produces separate JS+CSS chunks in the build output
- [ ] vanilla-extract styles appear in the per-chunk CSS
- [ ] Head tags (`<title>`, `<meta>`) are present in the initial streamed HTML and update on client-side navigation
- [ ] SQLite data persists across `docker compose down` / `up`

<!-- BEGIN BEADS INTEGRATION v:1 profile:full hash:f65d5d33 -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Quality
- Use `--acceptance` and `--design` fields when creating issues
- Use `--validate` to check description completeness

### Lifecycle
- `bd defer <id>` / `bd supersede <id>` for issue management
- `bd stale` / `bd orphans` / `bd lint` for hygiene
- `bd human <id>` to flag for human decisions
- `bd formula list` / `bd mol pour <name>` for structured workflows

### Auto-Sync

bd automatically syncs via Dolt:

- Each write auto-commits to Dolt history
- Use `bd dolt push`/`bd dolt pull` for remote sync
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Clean up** - Clear stashes, prune remote branches
5. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

<!-- END BEADS INTEGRATION -->
