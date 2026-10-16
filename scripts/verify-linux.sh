#!/usr/bin/env bash
#
# RUN THE FULL GATE ON LINUX, FROM WINDOWS, IN A CONTAINER THAT IS REAPED IMMEDIATELY.
#
# The owner's machine is Windows. CI is ubuntu. **Local green is not CI green**, and this
# repository has already paid for that once: `test/paths.test.ts` hard-coded
# `C:\Users\…\Genie.exe`, passed here, and failed on the runner — because `path.join` is
# host-specific and a Windows path on POSIX is one long segment with no separators in it, so
# every containment answer inverted.
#
# Pushing to find out costs a round trip and leaves a red commit on `main`. This costs ~40s.
#
# ## This is not the thing the house rules forbid
#
# No browser, no Electron, no window, no dev server, nothing that outlives the command. A
# `--rm` container that runs a test suite and exits is the measurement the rules ask for; the
# prohibition is on GUIs and long-running processes on the owner's live desktop.
#
# ## Why it copies instead of mounting in place
#
# `node_modules` here holds Windows binaries — esbuild, rollup's native bindings — which a
# Linux container cannot execute. The source is copied out of a read-only mount and the
# dependencies are installed fresh inside, which is also what CI does.
#
# `--ignore-scripts` skips Electron's postinstall. That only downloads a ~100MB binary to run
# the app with, and nothing here runs the app. Everything that needs the `electron` package
# itself — the main process's imports, the typecheck — has it, because `npm ci` still installs
# the package.
#
# Usage:  bash scripts/verify-linux.sh

set -euo pipefail

# `pwd -W` gives the Windows path Docker Desktop needs; plain `pwd` is right everywhere else.
# Braced deliberately: without the group, `&&` binds tighter than `||` and the fallback
# concatenates both answers into one unusable path.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && { pwd -W 2>/dev/null || pwd; })"
# MSYS_NO_PATHCONV stops Git Bash rewriting the container-side path into a Windows one, which
# turns `-v …:/src` into a mount named after the Git installation directory.
#
# One mount, and the inner script is reached through it — see the note at the top of
# `verify-linux-inner.sh` for why it is not a temp file.
MSYS_NO_PATHCONV=1 docker run --rm     -v "${REPO}:/src:ro"     node:22-bookworm-slim bash /src/scripts/verify-linux-inner.sh
