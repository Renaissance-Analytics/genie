#!/usr/bin/env bash
#
# Runs INSIDE the container launched by `verify-linux.sh`. Not meant to be run directly.
#
# It is a committed file rather than a heredoc written to a temp path because Docker Desktop
# on Windows cannot mount a Git-Bash `/tmp/...` path — it silently creates a DIRECTORY at the
# mount point instead, and the container then fails with "Is a directory". The repository is
# already mounted at /src, so reaching the script through that mount needs no second one, and
# has the side benefit that what runs in CI's shape is reviewable in the diff.

set -euo pipefail

# `node_modules` on the host holds Windows binaries — esbuild, rollup's native bindings — that
# a Linux container cannot execute, so the source is copied out of the read-only mount and the
# dependencies are installed fresh. Which is also what CI does.
mkdir -p /work
cd /src
tar cf - --exclude=node_modules --exclude=dist --exclude=.git . | (cd /work && tar xf -)
cd /work

echo "=== npm ci ==="
# `--ignore-scripts` skips Electron's postinstall, which only downloads a ~100MB binary to run
# the app with. Nothing here runs the app, and everything that needs the `electron` PACKAGE —
# the main process's imports, the typecheck — still has it.
npm ci --ignore-scripts --no-audit --no-fund >/tmp/ci.log 2>&1 || { tail -40 /tmp/ci.log; exit 1; }

echo "=== typecheck ==="
npm run typecheck

echo "=== test ==="
npm test 2>&1 | tail -12

echo "=== build ==="
npm run build >/tmp/build.log 2>&1 || { tail -40 /tmp/build.log; exit 1; }

# The same assertions CI makes, because "it built" is not "it is there, and it is the right
# shape". Three failures these have already caught or would catch silently:
#  - a sandboxed preload MUST be CommonJS; an ESM one loads as nothing and `window.genie` is
#    simply absent, so the app opens looking like a Dashboard with no agents;
#  - an absolute asset path 404s into a white window over `file://`;
#  - Tailwind emits only classes it finds in a scanned file, so a wrong `@source` ships a
#    stylesheet with none of the board's metrics in it.
echo "=== artifacts ==="
test -f dist/renderer/index.html
test -f dist/main/main.js
test -f dist/main/preload.cjs
grep -q "require(" dist/main/preload.cjs
! grep -qE "^import .* from" dist/main/preload.cjs
! grep -qE '(src|href)="/' dist/renderer/index.html
css=$(ls dist/renderer/assets/*.css)
grep -q "150px_minmax" "$css"
grep -q "280px" "$css"
grep -q "30px" "$css"

echo "ALL LINUX ASSERTIONS PASS"
