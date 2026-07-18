# Shared Playwright CDP browser image (task web_ui_ssr_experiment-1w9.5).
#
# A NEW-HEADLESS Chromium that honours --unsafely-treat-insecure-origin-as-secure
# (which old headless-shell ignores — Playwright #22944), plus socat to bridge the
# published :9222 to Chromium's loopback-only DevTools port. See run.sh for the
# full rationale. Pinned by digest for reproducibility (zenika/alpine-chrome:124,
# Chromium 124, Alpine).
FROM zenika/alpine-chrome@sha256:88859ddda17e1faef0b1a0fd38d9c4761dbe1e9b1fb1aa5a14222e53bc20a5f5

# socat bridges 0.0.0.0:9222 -> 127.0.0.1:9223 (Chromium binds DevTools to loopback
# under new headless). apk index pinning is unnecessary for this single throwaway
# test-only tool; hadolint DL3018 (pin apk versions) is intentionally accepted here.
USER root
# hadolint ignore=DL3018
RUN apk add --no-cache socat

COPY run.sh /usr/local/bin/run.sh
RUN chmod +x /usr/local/bin/run.sh

# Drop back to the image's unprivileged chrome user (socat's :9222 listen needs no
# privilege) and replace zenika's `chromium-browser --headless` (OLD headless)
# entrypoint with our new-headless + socat launcher.
USER chrome
ENTRYPOINT ["/usr/local/bin/run.sh"]
