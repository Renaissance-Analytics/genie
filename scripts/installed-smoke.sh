#!/usr/bin/env bash
#
# BUILD THE INSTALLER AND RUN WHAT IT PRODUCES.
#
# The regular smoke proves the CODE works by running `npx electron .` against `dist/`. This
# proves the ARTIFACT works, which is a different claim: between them sit asar packing, the
# `files` glob, the entry path inside the archive, and every default electron-builder applies
# that a dev run never exercises.
#
# "Nobody has installed an installer" was the most concrete unproven item on this build's
# status. This is how it stops being one.
#
# Slower than the source smoke (it packages first), so it is not on every push — it belongs
# before a release, next to `verify:live` and `verify:flow`.
#
# Usage:  bash scripts/installed-smoke.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && { pwd -W 2>/dev/null || pwd; })"
IMAGE="genie2-smoke:5"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "=== building the smoke image (once) ==="
    MSYS_NO_PATHCONV=1 docker build -f "${REPO}/scripts/smoke.Dockerfile" -t "$IMAGE" "${REPO}/scripts"
fi

MSYS_NO_PATHCONV=1 docker run --rm \
    -v "${REPO}:/src:ro" \
    -v "${REPO}:/out" \
    "$IMAGE" bash /src/scripts/installed-smoke-inner.sh
