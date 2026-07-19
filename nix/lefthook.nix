# lefthook git hooks (2pk.2) — replaces the prek / git-hooks.nix runner.
#
# This module is the SINGLE SOURCE OF TRUTH for the pre-commit hook set. It
# renders `lefthook.yml` (committed at the repo root) from the `lefthookConfig`
# attrset below. The devshell installs the hooks by reading that one file:
#   • `nix develop` — nix/devshell.nix shellHook runs `lefthook install`
# (2pk.4: devenv is retired, so the nix devshell is the only installer.)
#
# The lefthook binary and most hook tools (buf, dclint via bunx, dockerfmt,
# hadolint, ast-grep) come from the devshell PATH; biome + eslint run from the
# `tooling` unit's node_modules/.bin (de-workspaced 5ae). lefthook, unlike
# git-hooks.nix, does not auto-provision tools from nixpkgs (design note 2pk.1,
# Gap 6: the switch is lateral — parallel Go runner gained, auto-tools lost).
#
# Parity with the 8 prek hooks (devenv.nix git-hooks.hooks / nix/devshell.nix):
#   prek id      lefthook cmd  glob (file scoping)                 files passed
#   buf-format   buf-format    *.proto                             yes ({staged_files})
#   buf-lint     buf-lint      *.proto                             no  (whole project)
#   biome        biome         *.{js,cjs,mjs,jsx,ts,tsx,json}      no  (biome --staged)
#   dockerfmt    dockerfmt     Dockerfile(.*)                      yes
#   hadolint     hadolint      Dockerfile(.*)                      yes
#   dclint       dclint        (docker-)?compose*.ya?ml            yes
#   eslint       eslint        *.{ts,tsx}                          yes  ← 8cc FIX
#   ast-grep     ast-grep      *.{ts,tsx,java}                     no  (whole-repo scan)
#
# 8cc root cause: the prek `eslint` hook reused git-hooks.nix's BUILT-IN `eslint`
# hook name, inheriting its default `files = "\\.js$"`. pre-commit/prek AND the
# `files` regex with `types_or = [ts tsx]`, so the filter demanded a file that is
# BOTH `*.js` AND TypeScript — an empty set, so the hook matched nothing and
# reported "(no files to check) Skipped" for every commit, in BOTH shells. Here
# there is no built-in to collide with: eslint is scoped by a single glob
# `*.{ts,tsx}` and receives the staged TS files via `{staged_files}`.
#
# Write hooks (buf-format, biome, dockerfmt) set `stage_fixed: true`: they edit
# files in place, and without re-staging lefthook would commit the UN-formatted
# staged blob (a silent no-op, the same failure class as 8cc). prek instead
# aborted the commit on modification; re-staging the fixes is the lefthook idiom
# and is strictly stronger (the fix lands in the same commit).
{
  perSystem =
    { pkgs, lib, ... }:
    let
      # ── Source of truth: the pre-commit hook set ───────────────────────────
      lefthookConfig = {
        pre-commit = {
          parallel = true;
          commands = {
            buf-format = {
              glob = "*.proto";
              run = "buf format -w {staged_files}";
              stage_fixed = true;
            };
            buf-lint = {
              glob = "*.proto";
              run = "buf lint";
            };
            biome = {
              glob = "*.{js,cjs,mjs,jsx,ts,tsx,json}";
              # De-workspaced (5ae): biome lives in the `tooling` unit (no root
              # node_modules), invoked by its committed bin path from the repo root.
              run = "tooling/node_modules/.bin/biome check --write --staged --no-errors-on-unmatched --colors=off";
              stage_fixed = true;
            };
            dockerfmt = {
              glob = "{Dockerfile,Dockerfile.*,*/Dockerfile,*/Dockerfile.*}";
              run = "dockerfmt --write --newline {staged_files}";
              stage_fixed = true;
            };
            hadolint = {
              glob = "{Dockerfile,Dockerfile.*,*/Dockerfile,*/Dockerfile.*}";
              run = "hadolint --config tooling/docker/hadolint.yaml {staged_files}";
            };
            dclint = {
              glob = "{compose*.yml,compose*.yaml,docker-compose*.yml,docker-compose*.yaml,*/compose*.yml,*/compose*.yaml,*/docker-compose*.yml,*/docker-compose*.yaml}";
              run = "bunx dclint --config tooling/docker/dclintrc.yaml {staged_files}";
            };
            eslint = {
              glob = "*.{ts,tsx}";
              # De-workspaced (5ae): eslint + plugins live in the `tooling` unit; the
              # base config is the repo-root eslint.config.ts (auto-discovered). Cache
              # under tooling/node_modules (the only guaranteed node_modules tree).
              run = "tooling/node_modules/.bin/eslint --no-warn-ignored --cache --cache-location tooling/node_modules/.cache/eslint {staged_files}";
            };
            ast-grep = {
              glob = "*.{ts,tsx,java}";
              run = "ast-grep scan";
            };
          };
        };
      };

      header = ''
        # DO NOT EDIT — generated from nix/lefthook.nix (beads web_ui_ssr_experiment-2pk.2).
        # Regenerate:  nix build .#lefthook-config && cp -f result lefthook.yml && chmod +w lefthook.yml
        # Source of truth + hook→prek parity table: nix/lefthook.nix.
      '';

      yamlBody = (pkgs.formats.yaml { }).generate "lefthook.body.yml" lefthookConfig;

      generated = pkgs.runCommand "lefthook.yml" { } ''
        { printf '%s' ${lib.escapeShellArg header}; cat ${yamlBody}; } > $out
      '';
    in
    {
      # Regeneration target: `nix build .#lefthook-config` → ./result is the
      # canonical lefthook.yml. Copy it over the committed file after any edit here.
      packages.lefthook-config = generated;

      # Drift guard: the committed lefthook.yml MUST equal the Nix-generated one,
      # so the file both shells read is provably the source of truth. Pure check,
      # part of `nix flake check`.
      checks.lefthook-config-sync = pkgs.runCommand "lefthook-config-sync" { } ''
        if ! diff -u ${../lefthook.yml} ${generated}; then
          echo "" >&2
          echo "ERROR: lefthook.yml drifted from nix/lefthook.nix." >&2
          echo "Run: nix build .#lefthook-config && cp -f result lefthook.yml && chmod +w lefthook.yml" >&2
          exit 1
        fi
        touch $out
      '';
    };
}
