#!/bin/sh
# Shared Playwright CDP browser entrypoint (task web_ui_ssr_experiment-1w9.5).
#
# NEW-HEADLESS Chromium (--headless=new) is used deliberately: OLD headless
# (chromedp/headless-shell) PROVABLY ignores --unsafely-treat-insecure-origin-as-secure
# (Playwright #22944), so navigator.serviceWorker stays undefined and e2e/sw.spec.ts
# can only skip. New headless honours the flag, so the SW specs genuinely execute.
#
# socat bridge (mirrors chromedp/headless-shell's own run.sh): new-headless Chromium
# binds --remote-debugging-port to 127.0.0.1 REGARDLESS of --remote-debugging-address
# (verified live: "DevTools listening on ws://127.0.0.1:9223"), so the published
# -p 9222:9222 mapping cannot reach CDP directly. socat forwards the externally
# reachable 0.0.0.0:9222 to Chromium's loopback DevTools on :9223, keeping the CDP
# endpoint reachable from the host and from test containers exactly as before.
#
# "$@" forwards the run-time flags (--user-data-dir, the quoted secure-origin
# wildcard) from `docker run` straight into the browser process argv.
set -e

socat TCP4-LISTEN:9222,fork,reuseaddr TCP4:127.0.0.1:9223 &

exec chromium-browser \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --use-gl=angle \
  --use-angle=swiftshader \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  "$@"
