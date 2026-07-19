# lefthook git hooks (2pk.2) — replaces the prek / git-hooks.nix runner.
#
# This module is the SINGLE SOURCE OF TRUTH for the pre-commit hook set. It
# renders `lefthook.yml` (committed at the repo root) from the `lefthookConfig`
# attrset below. The devshell installs the hooks by reading that one file:
#   • `nix develop` — nix/devshell.nix shellHook runs `lefthook install`
# (2pk.4: devenv is retired, so the nix devshell is the only installer.)
#
# The lefthook binary and the remaining hook tools (buf, ast-grep) come from the
# devshell PATH; biome + eslint run from the
# `tooling` unit's node_modules/.bin (de-workspaced 5ae). lefthook, unlike
# git-hooks.nix, does not auto-provision tools from nixpkgs (design note 2pk.1,
# Gap 6: the switch is lateral — parallel Go runner gained, auto-tools lost).
#
# Hook set (1vl: dockerfmt/hadolint/dclint DROPPED — Dockerfiles + compose are
# gone, replaced by nix2container images + the Arion-generated compose):
#   prek id      lefthook cmd  glob (file scoping)                 files passed
#   buf-format   buf-format    *.proto                             yes ({staged_files})
#   buf-lint     buf-lint      *.proto                             no  (whole project)
#   biome        biome         *.{js,cjs,mjs,jsx,ts,tsx,json}      no  (biome --staged, ci.json — 5cn)
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
# Write hooks (buf-format, biome) set `stage_fixed: true`: they edit
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
              #
              # ── Hook ⇄ CI ALIGNMENT (5cn) ────────────────────────────────────
              # `--config-path tooling/biome/ci.json` makes the hook run the SAME
              # config as the `ci-biome` gate (nix/apps.nix, nix/checks.nix), which
              # extends base.json with ~15 type-aware nursery rules at error
              # (noFloatingPromises, noMisusedPromises, noUnnecessaryConditions,
              # useNullishCoalescing, …). Before 5cn the hook used biome.json (base
              # only), so a file could pass the commit hook yet fail ci-biome. Now a
              # hook-green commit is ci-biome-green for the staged files.
              #
              # Why this is safe + fast (measured 5cn, biome 2.4.16):
              #   • Fast: the ci config adds only ~80–100 ms over base on a warm run;
              #     worst case (all 74 TS files) 0.42–0.45 s, whole-repo `check .`
              #     0.47 s — far under the ~2 s budget for a typical few-file commit.
              #   • No unwanted `--write` mutation: every ci-only nursery rule is a
              #     type-aware DIAGNOSTIC with NO autofix — `--write` (safe fixes
              #     only; we never pass `--unsafe`) applies nothing for them, so they
              #     REPORT-and-BLOCK (biome exits non-zero) without touching the file.
              #     `--write` still auto-applies + re-stages base-tier safe fixes
              #     (formatting, organizeImports) exactly as before.
              #   • `--staged` scoping is compatible: biome resolves types across the
              #     whole project but only emits diagnostics for the staged files.
              # If a future nursery rule ships a SAFE autofix that would mutate on
              # `--write`, split the nursery tier into a check-only invocation rather
              # than dropping the alignment. `--no-errors-on-unmatched` only silences
              # empty-glob runs; it does NOT suppress lint errors.
              run = "tooling/node_modules/.bin/biome check --write --staged --no-errors-on-unmatched --colors=off --config-path tooling/biome/ci.json";
              stage_fixed = true;
            };
            # dockerfmt / hadolint / dclint hooks removed (1vl): all Dockerfiles
            # and docker-compose.yml are deleted — nix2container images + the
            # Arion-generated compose replace them, so there is nothing left for
            # these hooks to lint. dockerfmt + hadolint were also dropped from the
            # devshell.
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
