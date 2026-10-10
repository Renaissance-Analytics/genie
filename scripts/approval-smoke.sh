#!/usr/bin/env bash
#
# THE APPROVAL ROUND TRIP — opt-in, because it does not pass yet.
#
# It drives a REAL parked approval: a stub that speaks the codex App Server protocol, through
# the real `CodexDriver`, the real session holding the promise the provider is blocked on, the
# real host, bridge and UI. Nothing above the stub is mocked.
#
# It is NOT in the merge gate. I put it there before it worked and turned `main` red, which is
# the one thing a gate must never be: a red build nobody can act on teaches people to stop
# reading red, and then the gate is worth nothing on the day it means something.
#
# Two product defects have already come out of building it, both of which would have shipped:
# a provider that could not start failed silently, and `onRequestPermission` was never
# forwarded to the driver at all — so the whole approval feature was unreachable in the running
# application while every unit test passed.
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
