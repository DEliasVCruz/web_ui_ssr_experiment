{ pkgs, ... }:

{
  # Load .env file automatically
  dotenv.enable = true;

  # System packages
  packages = [
    pkgs.bun
    pkgs.nodejs_22
    pkgs.buf
    pkgs.git
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
  };
}
