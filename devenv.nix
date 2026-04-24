{ pkgs, ... }:

let
  dockerfmt = pkgs.buildGoModule rec {
    pname = "dockerfmt";
    version = "0.5.2";
    src = pkgs.fetchFromGitHub {
      owner = "reteps";
      repo = "dockerfmt";
      rev = "v${version}";
      hash = "sha256-WfwrFe3E+CzfZ0ITSjMD8h4yrG+mnC6y0L+7OSYjMsw=";
    };
    vendorHash = "sha256-r8vmbZ4oyplqIU6R/6hhcyjoR3E/mOFrB69TrfPYxRI=";
  };
in
{
  # Load .env file automatically
  dotenv.enable = true;

  # System packages
  packages = [
    pkgs.bun
    pkgs.nodejs_22
    pkgs.buf
    pkgs.git
    pkgs.hadolint
    pkgs.colima
    pkgs.docker-client
    dockerfmt
  ];

  # Shared, non-secret env vars
  env = {
    NODE_ENV = "development";
  };

  # Only runs bun install when lockfile changes
  enterShell = ''
    if [ -f package.json ]; then
      lock_hash=""
      if [ -f bun.lock ]; then
        lock_hash=$(md5 -q bun.lock 2>/dev/null || md5sum bun.lock | cut -d' ' -f1)
      fi
      cache_file="node_modules/.devenv-lock-hash"

      if [ ! -d node_modules ] || [ ! -f "$cache_file" ] || [ "$lock_hash" != "$(cat "$cache_file" 2>/dev/null)" ]; then
        echo "Lock file changed, running bun install..."
        bun install
        echo "$lock_hash" > "$cache_file"
      fi
    fi
  '';

  # Developer tasks
  tasks = {
    "biome:check" = {
      exec = "bunx biome check .";
      description = "Run Biome formatter, linter and import sorting checks";
    };
    "biome:fix" = {
      exec = "bunx biome check --write .";
      description = "Auto-fix Biome formatter, linter and import sorting issues";
    };
    "biome:format" = {
      exec = "bunx biome format --write .";
      description = "Format code with Biome";
    };
    "biome:lint" = {
      exec = "bunx biome lint .";
      description = "Lint code with Biome";
    };
    "ts:check" = {
      exec = "bun run --filter '*' typecheck";
      description = "Run TypeScript type checking across all workspaces";
    };
    "buf:generate" = {
      exec = "buf generate";
      description = "Generate TypeScript code from protobuf definitions";
    };
    "buf:format" = {
      exec = "buf format -w";
      description = "Format protobuf files with buf";
    };
    "buf:format:check" = {
      exec = "buf format --exit-code";
      description = "Check protobuf formatting without modifying files";
    };
    "buf:lint" = {
      exec = "buf lint";
      description = "Lint protobuf files with buf";
    };
    "docker:fmt" = {
      exec = ''
        if [ -n "$1" ]; then
          dockerfmt --write --newline "$1"
        else
          find . -name 'Dockerfile*' -not -path '*/node_modules/*' -exec dockerfmt --write --newline {} +
        fi
      '';
      description = "Format Dockerfiles with dockerfmt (pass a path to format a specific file)";
    };
    "docker:fmt:check" = {
      exec = ''find . -name 'Dockerfile*' -not -path '*/node_modules/*' -exec dockerfmt --check --newline {} +'';
      description = "Check Dockerfile formatting without modifying files";
    };
    "docker:lint" = {
      exec = ''
        if [ -n "$1" ]; then
          hadolint --config tooling/docker/hadolint.yaml "$1"
        else
          find . -name 'Dockerfile*' -not -path '*/node_modules/*' -exec hadolint --config tooling/docker/hadolint.yaml {} +
        fi
      '';
      description = "Lint Dockerfiles with hadolint (pass a path to lint a specific file)";
    };
    "eslint:check" = {
      exec = ''
        if [ -n "$1" ]; then
          bun run --filter "$1" lint:eslint
        else
          echo "Usage: devenv tasks run eslint:check -- <package-name>"
          exit 1
        fi
      '';
      description = "Run ESLint on a specific workspace (pass package name as argument)";
    };
    "eslint:fix" = {
      exec = ''
        if [ -n "$1" ]; then
          bun run --filter "$1" lint:eslint -- --fix
        else
          echo "Usage: devenv tasks run eslint:fix -- <package-name>"
          exit 1
        fi
      '';
      description = "Run ESLint with auto-fix on a specific workspace (pass package name as argument)";
    };
    "eslint:check:all" = {
      exec = "bun run --filter '*' lint:eslint";
      description = "Run ESLint across all workspaces";
    };
    "compose:lint" = {
      exec = ''bunx dclint . --recursive --config tooling/docker/dclintrc.yaml --exclude .devenv node_modules'';
      description = "Lint docker-compose files with dclint";
    };
    "compose:lint:fix" = {
      exec = ''bunx dclint . --recursive --fix --config tooling/docker/dclintrc.yaml --exclude .devenv node_modules'';
      description = "Auto-fix docker-compose lint issues";
    };
    "playwright:up" = {
      exec = ''
        # Start Colima if not running
        if ! colima status 2>/dev/null | grep -q "Running"; then
          echo "Starting Colima..."
          colima start
        fi
        # Run headless Chromium container with CDP endpoint
        if docker ps --format '{{.Names}}' | grep -q '^playwright-browser$'; then
          echo "Playwright browser already running on http://localhost:9222"
        else
          docker rm -f playwright-browser 2>/dev/null || true
          echo "Starting headless Chromium container..."
          docker run -d --name playwright-browser --shm-size=2g -p 9222:9222 \
            chromedp/headless-shell:latest
          echo "Playwright browser running on http://localhost:9222"
        fi
      '';
      description = "Start Colima and headless Chromium container with CDP on port 9222";
    };
    "playwright:down" = {
      exec = ''
        docker rm -f playwright-browser 2>/dev/null && echo "Playwright container stopped" || echo "No Playwright container running"
      '';
      description = "Stop the Playwright Chromium container";
    };
    # ─── CI-only tasks (type-aware, slower) ──────────────────────────
    "ci:biome" = {
      exec = "bunx biome check . --config-path tooling/biome/ci.json";
      description = "Run Biome with type-aware rules (CI only)";
    };
    "ci:eslint" = {
      exec = "bunx eslint --config tooling/eslint/ci.ts";
      description = "Run ESLint with typescript-eslint type-checked rules (CI only)";
    };
    "ci:lint" = {
      exec = ''
        echo "==> Biome (base + types domain)"
        bunx biome check . --config-path tooling/biome/ci.json
        echo "==> ESLint (precommit + type-checked)"
        bunx eslint --config tooling/eslint/ci.ts
      '';
      description = "Run all CI linters (Biome types + ESLint type-checked)";
    };
  };

  # Use prek as the git hooks engine (Rust rewrite, devenv 2.0 native)
  git-hooks.package = pkgs.prek;

  # Pre-commit hooks
  git-hooks.hooks = {
    buf-format = {
      enable = true;
      name = "buf format";
      entry = "buf format -w";
      files = "\\.proto$";
      pass_filenames = true;
    };
    buf-lint = {
      enable = true;
      name = "buf lint";
      entry = "buf lint";
      files = "\\.proto$";
      pass_filenames = false;
    };
    biome = {
      enable = true;
      name = "biome check";
      entry = "bunx biome check --write --staged --no-errors-on-unmatched --colors=off";
      pass_filenames = false;
      types_or = [ "javascript" "jsx" "ts" "tsx" "json" ];
    };
    dockerfmt = {
      enable = true;
      name = "dockerfmt";
      entry = "${dockerfmt}/bin/dockerfmt --write --newline";
      files = "(^|/)Dockerfile";
      pass_filenames = true;
    };
    hadolint = {
      enable = true;
      name = "hadolint";
      entry = "hadolint --config tooling/docker/hadolint.yaml";
      types = [ "dockerfile" ];
    };
    dclint = {
      enable = true;
      name = "dclint";
      entry = "bunx dclint --config tooling/docker/dclintrc.yaml";
      files = "(^|/)(docker-)?compose[^/]*\\.ya?ml$";
      pass_filenames = true;
    };
    eslint = {
      enable = true;
      name = "eslint";
      entry = "bunx eslint --no-warn-ignored --cache --cache-location node_modules/.cache/eslint";
      pass_filenames = true;
      types_or = [ "ts" "tsx" ];
    };
  };
}
