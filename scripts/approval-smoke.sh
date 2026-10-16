#!/usr/bin/env bash
#
# THE APPROVAL ROUND TRIP, on its own.
#
# The same thing the main smoke now runs — this just isolates it when you are working on that
# path specifically. A stub speaking the real codex App Server protocol, through the real
# `CodexDriver`, the real session holding the promise the provider is blocked on, the real
# host, bridge and UI. Nothing above the stub is mocked.
#
# Three defects came out of building it, all of which would have shipped, and none of which a
# unit test could have found:
#   - a provider that could not start failed SILENTLY;
#   - `onRequestPermission` was never forwarded to the driver, so the feature was unreachable;
#   - a parked approval notified nobody, so the screen stayed blank while the session held it.
#
# Usage:  bash scripts/approval-smoke.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && { pwd -W 2>/dev/null || pwd; })"
IMAGE="genie2-smoke:6"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    MSYS_NO_PATHCONV=1 docker build -f "${REPO}/scripts/smoke.Dockerfile" -t "$IMAGE" "${REPO}/scripts"
fi

MSYS_NO_PATHCONV=1 docker run --rm \
    -e SMOKE_APPROVAL=1 \
    -v "${REPO}:/src:ro" \
    -v "${REPO}:/out" \
    "$IMAGE" bash /src/scripts/smoke-linux-inner.sh
