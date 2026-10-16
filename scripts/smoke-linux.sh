#!/usr/bin/env bash
#
# OPEN THE APP. In a container, on a virtual display, reaped in the same command.
#
# §8.1's smoke path, and the thing that was missing from all four failed betas: **nobody ever
# opened the built app.** Four releases shipped on green unit suites and every one of them was
# broken the moment a human looked at it.
#
# ## This is not what the desktop rule forbids
#
# The rule is absolute about the owner's live machine — no browser, no Electron, no window, no
# dev server. It is also explicit that a container reaped in the same breath is the measurement
# the rules ask for, and that verification belongs "on CI, or in a VM". This is the VM half,
# available locally, so a broken boot is caught in two minutes instead of after a push.
#
# Nothing here puts a window on anybody's screen: Xvfb is a virtual display inside the
# container, and the container is gone when the command returns.
#
# Usage:  bash scripts/smoke-linux.sh
# Output: a screenshot at ./smoke-dashboard.png, for a human to actually look at.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && { pwd -W 2>/dev/null || pwd; })"
IMAGE="genie2-smoke:6"

# Built by tag and cached. The apt install is the slow part, and a verification that takes four
# minutes every time stops being run — which is how "nobody opened the app" happens.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "=== building the smoke image (once) ==="
    MSYS_NO_PATHCONV=1 docker build -f "${REPO}/scripts/smoke.Dockerfile" -t "$IMAGE" "${REPO}/scripts"
fi

MSYS_NO_PATHCONV=1 docker run --rm \
    -v "${REPO}:/src:ro" \
    -v "${REPO}:/out" \
    "$IMAGE" bash /src/scripts/smoke-linux-inner.sh
