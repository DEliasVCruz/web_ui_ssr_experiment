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
          hadolint "$1"
        else
          find . -name 'Dockerfile*' -not -path '*/node_modules/*' -exec hadolint {} +
        fi
      '';
      description = "Lint Dockerfiles with hadolint (pass a path to lint a specific file)";
    };
    "compose:lint" = {
      exec = ''bunx dclint . --recursive --exclude .devenv node_modules'';
      description = "Lint docker-compose files with dclint";
    };
    "compose:lint:fix" = {
      exec = ''bunx dclint . --recursive --fix --exclude .devenv node_modules'';
      description = "Auto-fix docker-compose lint issues";
    };
  };

  # Pre-commit hooks
  git-hooks.hooks = {
    biome = {
      enable = true;
      name = "biome check";
      entry = "bunx biome check --staged --no-errors-on-unmatched --colors=off";
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
      entry = "hadolint";
      types = [ "dockerfile" ];
    };
    dclint = {
      enable = true;
      name = "dclint";
      entry = "bunx dclint";
      files = "(^|/)(docker-)?compose[^/]*\\.ya?ml$";
      pass_filenames = true;
    };
  };
}
