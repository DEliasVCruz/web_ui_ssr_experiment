#!/usr/bin/env bash
# Hermetic jOOQ codegen (task 2pk.6) — replaces the
# testcontainers-jooq-codegen-maven-plugin, which needed a container runtime
# (Docker/podman socket) at build time.
#
# What it does, with NOTHING but the postgres client/server binaries on PATH,
# a writable TMPDIR, and Maven:
#   1. `initdb` a throwaway data dir under a private temp dir,
#   2. start an ephemeral PostgreSQL listening ONLY on a loopback TCP port and a
#      unix socket inside that temp dir (no shared TCP surface, no daemon),
#   3. apply THIS module's real Flyway migrations (flyway-maven-plugin),
#   4. run jOOQ codegen against the live catalog (jooq-codegen-maven), emitting
#      target/generated-sources/jooq,
#   5. tear postgres down and delete the temp dir (trap, even on failure).
#
# It needs NO Docker socket, NO network egress, and NO privileged anything —
# just local processes over loopback — so it runs identically in the devenv
# shell today and in a future pure Nix build sandbox (2pk.3), which provides
# loopback + the postgres binaries but no container daemon.
#
# Flyway + jOOQ run through Maven (the `jooq-codegen` profile in this module's
# pom), so their versions stay pinned by the reactor and generated code can
# never drift from the runtime jOOQ/Flyway pins.
set -euo pipefail

MODULE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "jooq-codegen: required binary '$1' not found on PATH" >&2
    exit 1
  }
}
require initdb
require pg_ctl
require createdb
require mvn

WORK="$(mktemp -d "${TMPDIR:-/tmp}/jooq-codegen.XXXXXX")"
PGDATA="$WORK/pgdata"
SOCKDIR="$WORK/sock"
PGLOG="$WORK/postgres.log"

cleanup() {
  local status=$?
  if [ -d "$PGDATA" ]; then
    pg_ctl -D "$PGDATA" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # On failure, surface the postgres log BEFORE deleting $WORK — otherwise a
  # `pg_ctl start` failure would destroy its own diagnostics.
  if [ "$status" -ne 0 ] && [ -f "$PGLOG" ]; then
    echo "jooq-codegen: FAILED (status $status) — last 50 lines of postgres log:" >&2
    tail -50 "$PGLOG" >&2 || true
  fi
  # $SOCKDIR is normally inside $WORK; when relocated (see the guard below) it is
  # separate, so remove both — rm -rf on an already-gone path is a no-op.
  rm -rf "$WORK" "$SOCKDIR"
  return $status
}
trap cleanup EXIT INT TERM

# Guard the unix-socket path length. Postgres appends "/.s.PGSQL.<port>" (up to
# 15 chars) to $SOCKDIR, and the whole path must fit the sockaddr_un sun_path
# limit (104 on macOS/BSD, 108 on Linux). A deep CI $TMPDIR can blow that; fall
# back to a short socket dir under /tmp rather than fail cryptically (and per the
# cleanup above, a failure here would otherwise delete its own explanation). The
# relocated dir is cleaned up by cleanup() via $SOCKDIR.
if [ $(( ${#SOCKDIR} + 15 )) -gt 100 ]; then
  SOCKDIR="$(mktemp -d "/tmp/jooq-pg.XXXXXX")"
  if [ $(( ${#SOCKDIR} + 15 )) -gt 100 ]; then
    echo "jooq-codegen: unix-socket path too long even under /tmp ($SOCKDIR); set TMPDIR to a short path" >&2
    exit 1
  fi
fi

mkdir -p "$SOCKDIR"

# Pick a free loopback TCP port. jOOQ/Flyway connect over TCP (pgjdbc has no
# native unix-socket transport); the unix socket in $SOCKDIR is what pg_ctl and
# createdb use for control. Probing with bash's /dev/tcp keeps this dependency
# free (no python/nc), which matters for the Nix-sandbox target.
find_free_port() {
  local port
  for _ in $(seq 1 100); do
    port=$(( (RANDOM % 20000) + 32768 ))
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      printf '%s\n' "$port"
      return 0
    fi
    exec 3>&- 2>/dev/null || true
  done
  echo "jooq-codegen: could not find a free loopback port" >&2
  return 1
}
PGPORT="$(find_free_port)"

echo "jooq-codegen: initdb -> $PGDATA"
# trust auth (loopback + unix socket only), C locale for determinism, no fsync
# (throwaway db — durability is irrelevant and this is much faster).
initdb -D "$PGDATA" -U postgres --auth=trust --no-sync --locale=C >/dev/null

echo "jooq-codegen: starting ephemeral postgres on 127.0.0.1:$PGPORT (socket $SOCKDIR)"
pg_ctl -D "$PGDATA" -l "$PGLOG" -w -t 60 -o \
  "-p $PGPORT -k $SOCKDIR -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off" \
  start

createdb -h "$SOCKDIR" -p "$PGPORT" -U postgres todos

JDBC_URL="jdbc:postgresql://127.0.0.1:$PGPORT/todos"
echo "jooq-codegen: flyway migrate + jOOQ codegen against $JDBC_URL"

# -Pjooq-codegen activates the flyway-maven-plugin + jooq-codegen-maven config
# in this module's pom. Fully-qualified goals so the versions/config are taken
# from that profile regardless of the invoking shell's plugin-prefix mappings.
# MAVEN_ARGS (e.g. "-o" for offline) is forwarded when set. NOTE: this nested mvn
# does NOT inherit the OUTER mvn's CLI flags (-o, -s, -Dmaven.repo.local, ...);
# pass anything the codegen must share via MAVEN_ARGS. Maven 3.9+ also reads
# MAVEN_ARGS from the environment natively, so those args are seen twice — a
# harmless no-op for idempotent flags like -o.
# shellcheck disable=SC2086  # MAVEN_ARGS is intentionally word-split into flags.
mvn ${MAVEN_ARGS:-} -q -f "$MODULE_DIR/pom.xml" -Pjooq-codegen \
  org.flywaydb:flyway-maven-plugin:migrate \
  org.jooq:jooq-codegen-maven:generate \
  -Djooq.codegen.jdbc.url="$JDBC_URL" \
  -Djooq.codegen.jdbc.user=postgres \
  -Djooq.codegen.jdbc.password=

echo "jooq-codegen: done -> $MODULE_DIR/target/generated-sources/jooq"
