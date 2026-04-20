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
}
