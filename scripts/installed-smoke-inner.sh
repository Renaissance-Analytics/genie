#!/usr/bin/env bash
#
# RUN THE PACKAGED ARTIFACT, not the source tree.
#
# The existing smoke runs `npx electron .` against `dist/`. That proves the code works. It does
# **not** prove the thing a user downloads works, and those are different claims — between them
# sit `asar` packing, the `files` glob, the entry path inside the archive, the unpacking of
# native bits, and every default electron-builder applies that the dev run never sees.
#
# "Nobody has installed an installer" was the most concrete unproven item on this build's
# status. This closes it: build the AppImage, run THAT, and drive it with the same CDP checks.
#
# AppImage needs FUSE to mount itself, which a container does not have.
# `--appimage-extract-and-run` unpacks to a temp dir and runs from there — the same payload,
# without the loopback mount.

set -euo pipefail

mkdir -p /work
cd /src
tar cf - --exclude=node_modules --exclude=dist --exclude=release --exclude=.git . | (cd /work && tar xf -)
cd /work

echo "=== npm ci ==="
npm ci --no-audit --no-fund >/tmp/ci.log 2>&1 || { tail -40 /tmp/ci.log; exit 1; }

echo "=== build the bundles ==="
npm run build >/tmp/build.log 2>&1 || { tail -40 /tmp/build.log; exit 1; }

echo "=== PACKAGE (the artifact a user would download) ==="
npx electron-builder --linux AppImage --publish never >/tmp/pack.log 2>&1 || { tail -60 /tmp/pack.log; exit 1; }

APPIMAGE="$(ls release/*.AppImage 2>/dev/null | head -1)"
if [ -z "$APPIMAGE" ]; then
    echo "no AppImage was produced"
    ls -la release/ || true
    exit 1
fi
chmod +x "$APPIMAGE"
echo "built: $APPIMAGE  ($(du -h "$APPIMAGE" | cut -f1))"

# Seed the same workspace and agent the source smoke uses, so the click-through has something
# to click. The packaged app reads the same `~/.config/genie2/runtime` a real install would.
echo "=== seeding ==="
node scripts/smoke-seed.mjs

echo "=== launching the INSTALLED app ==="
xvfb-run --auto-servernum --server-args='-screen 0 1440x900x24' \
    "$APPIMAGE" --appimage-extract-and-run --no-sandbox --remote-debugging-port=9222 \
    >/tmp/electron.log 2>&1 &
APP_PID=$!

cleanup() {
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== driving the packaged app over CDP ==="
if node scripts/smoke-cdp.mjs; then
    status=0
else
    status=$?
    echo ""
    echo "--- the app's own output ---"
    tail -60 /tmp/electron.log || true
fi

if [ -d /out ]; then
    for shot in smoke-dashboard.png smoke-agent.png; do
        [ -f "/work/$shot" ] && cp "/work/$shot" "/out/installed-$shot" && echo "installed-$shot copied to the host"
    done
fi

exit "$status"
