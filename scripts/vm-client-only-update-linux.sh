#!/usr/bin/env bash
# vm-client-only-update-linux.sh — A CLIENT-ONLY UPDATE ON LINUX, PROVEN (Tynn #1036 P6-1; Tynn #413, host split P6).
#
# The Linux twin of scripts/vm-client-only-update.ps1. Needs a test machine (user `genie`, or GENIE_TEST_MACHINE=1), its
# Hyprland session (the window rows' display), FUSE (an AppImage mounts itself), and this checkout with `npm ci` run:
#
#   bash scripts/vm-client-only-update-linux.sh [base] [next]        (default 2.0.0 2.0.1)
#
# The installed Genie is an AppImage at ~/Applications/Genie.AppImage, a name with no version in it, so electron-updater
# replaces that file in place. Both builds are packaged with a `generic` feed at http://127.0.0.1:8099/ (the AppImage's
# app-update.yml is inside its read-only image, so it is written at packaging, where Windows overwrites the installed
# file), and $Next differs from $Base in its version only: the SAME genie-host. latest-linux.yml names that host
# (scripts/feed-host-identity.mjs, as the release does), so the installed Genie classifies the update client-only. The row:
#
#   the same genie-host pid (and start time), running from its copy under ~/.genie/host/, and the same agent provider
#   pids before and after the update; none started again; ~/Applications/Genie.AppImage is $Next's; the window came back
#   on its own; genie-host logged that only the window was updated; and THE AGENT STREAMED THROUGH IT: its provider is the
#   stub in TICKER mode (a marker holding this script's pid), mid-turn when install is asked, and a window of $Next on the
#   same host finds every tick streamed while there was no window in its ledger, in order (update-ticks-after-cdp.mjs).
#
# UPDATE_TICKS_BREAK=stop-provider is the row's break probe: the provider is ended during the install; the row fails on it.
#
# If the two builds' host bundles differ, there is no client-only update to prove: `### client-only=NOT-CLIENT-ONLY`.
# Prints `### client-only=PASS` at the end; a failure prints `### client-only=FAIL <why>` and exits 1.
set -uo pipefail
BASE="${1:-2.0.0}"
NEXT="${2:-2.0.1}"
ROOT="$(pwd)"
LOG="$ROOT/update-linux.log"
exec > >(tee "$LOG") 2>&1
APPS="$HOME/Applications"
APPIMAGE_FILE="$APPS/Genie.AppImage"
GHOME="$HOME/.genie"
HOST_RECORD="$GHOME/runtime/host.json"
HOST_LOG="$GHOME/logs/genie-host.log"
FEED_URL='http://127.0.0.1:8099/'
FEED_PID=''
APP_PID=''
TICKER="$(node -p 'require("os").tmpdir()')/genie-stub-codex-ticker"

step() { echo; echo "=== $* ==="; }
fail() { echo "### client-only=FAIL $*"; exit 1; }
run() { local log="$1"; shift; "$@" >"$log" 2>&1 || { tail -40 "$log"; fail "FAILED: $*"; }; }

cleanup() {
    [ -n "$FEED_PID" ] && kill "$FEED_PID" 2>/dev/null
    rm -f "$TICKER"
    # Pass or fail, what the run started goes: its windows, genie-host from its copy, the providers.
    end_all
    [ -f package.json.pristine ] && mv -f package.json.pristine package.json
    [ -f package-lock.json.pristine ] && mv -f package-lock.json.pristine package-lock.json
    rm -f "$ROOT/electron-builder.client-only-feed.json"
}
trap cleanup EXIT

# --- where it may run, and what it needs ----------------------------------------------------------------------------
if [ "${GENIE_TEST_MACHINE:-}" != 1 ] && [ "$(id -un)" != genie ]; then fail "not a test machine (user $(id -un)); GENIE_TEST_MACHINE=1 says this machine is"; fi
export GENIE_TEST_MACHINE=1 GENIE_PLAYWRIGHT_AUTO_INSTALL=0
# The session's own display variables (scripts/ci/linux.sh take_session_display): a shell that came in over ssh is not in it.
if ! { [ "${XDG_SESSION_TYPE:-}" = wayland ] && [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
    env_now="$(systemctl --user show-environment 2>/dev/null || true)"
    for name in XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE; do
        line="$(grep -m1 "^$name=" <<<"$env_now" || true)"
        [ -n "$line" ] && export "$name=${line#*=}"
    done
fi
[ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/$WAYLAND_DISPLAY" ] || fail "no Hyprland session: WAYLAND_DISPLAY='${WAYLAND_DISPLAY:-}'"
echo "display: XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-} WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
# An AppImage mounts itself with FUSE: /dev/fuse and a fusermount. Installed when missing (pacman, as the rows' need_cmd).
# electron-builder's AppImage runtime loads libfuse.so.2 (measured, 1123-201245-948f6a: "dlopen(): error loading
# libfuse.so.2" with fusermount3 present): fuse2 is what a person installs for any AppImage on Arch.
if { ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; } || ! ldconfig -p 2>/dev/null | grep -q 'libfuse[.]so[.]2'; then
    echo "no fusermount or no libfuse.so.2: installing fuse2"
    # The VM's package database is not synced (measured, 1123-205944-a119e0: "target not found: fuse3"): -Sy for it.
    if ! sudo -n pacman -Sy --needed --noconfirm fuse2 >fuse-install.log 2>&1; then
        tail -20 fuse-install.log
        # Not mountable here: the AppImage's own extract-and-run (the same payload, unpacked under /tmp, the same APPIMAGE
        # the updater replaces). Said, because a person's machine mounts it.
        echo 'FUSE 2 could not be installed: the AppImage runs with APPIMAGE_EXTRACT_AND_RUN=1 (not a FUSE mount)'
        export APPIMAGE_EXTRACT_AND_RUN=1
    fi
fi
[ -n "${APPIMAGE_EXTRACT_AND_RUN:-}" ] || [ -e /dev/fuse ] || fail 'no /dev/fuse: an AppImage cannot mount itself here'
echo "fuse: $(command -v fusermount3 || command -v fusermount); $(ldconfig -p 2>/dev/null | grep -m1 'libfuse[.]so[.]2' | sed 's/^[[:space:]]*//')"

started_at() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//'; }
host_pid() { node -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(r.pid ?? "") } catch { console.log("") }' "$HOST_RECORD"; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
stub_pids() { pgrep -f 'stub-codex\.mjs' | sort -n | tr '\n' ' ' | sed 's/ $//'; }
# Every Genie process of this run: what runs from an AppImage mount, the AppImage runtimes, and the host's copy.
genie_pids() {
    for p in /proc/[0-9]*; do
        exe="$(readlink "$p/exe" 2>/dev/null)" || continue
        case "$exe" in /tmp/.mount_*|"$GHOME"/host/*) echo "${p#/proc/}" ;; esac
    done
    pgrep -f "^$APPIMAGE_FILE" || true
}
end_all() { for p in $(genie_pids) $(pgrep -f 'stub-codex\.mjs'); do kill -9 "$p" 2>/dev/null; done; sleep 2; }
# The window's processes only: what runs from an AppImage (mounted or extracted) and the AppImage runtimes. Never the host's copy.
window_pids() {
    for p in /proc/[0-9]*; do
        exe="$(readlink "$p/exe" 2>/dev/null)" || continue
        case "$exe" in /tmp/.mount_*|/tmp/appimage_extracted_*) echo "${p#/proc/}" ;; esac
    done
    pgrep -f "^$APPIMAGE_FILE" || true
}

cp -f package.json package.json.pristine
cp -f package-lock.json package-lock.json.pristine
# The packaging config with the local feed as its publish target, whole: electron-builder merges a `-c.publish.*` override
# into the github block (owner, repo, releaseType stay) and its schema refuses that for `generic` (measured, 1123-192745).
FEED_CONFIG="$ROOT/electron-builder.client-only-feed.json"
node -e '
const fs = require("fs");
let yaml; try { yaml = require("js-yaml"); } catch { yaml = null; }
const text = fs.readFileSync("electron-builder.yml", "utf8");
const config = yaml ? yaml.load(text) : require("yaml").parse(text);
config.publish = { provider: "generic", url: process.argv[1] };
fs.writeFileSync(process.argv[2], JSON.stringify(config, null, 2));
' "$FEED_URL" "$FEED_CONFIG" || fail 'the packaging config with the local feed could not be written'
echo "packaging with: $FEED_CONFIG (publish: generic $FEED_URL)"

# --- the base: packaged, "installed", launched -------------------------------------------------------------------------
step "package $BASE and install it"
end_all
rm -rf release "$GHOME"
run bump-base.log npm version "$BASE" --no-git-tag-version --allow-same-version
run build-base.log npm run build
BASE_HASH="$(sha256sum dist/main/host.js | cut -c1-12)"
echo "the base build's genie-host: $BASE_HASH"
run package-base.log npx electron-builder --linux AppImage --publish never --config "$FEED_CONFIG"
base_image="$(ls release/*"$BASE"*.AppImage 2>/dev/null | head -1)"
[ -n "$base_image" ] || { ls -la release; fail "no $BASE AppImage in release/"; }
mkdir -p "$APPS"
cp -f "$base_image" "$APPIMAGE_FILE"
chmod +x "$APPIMAGE_FILE"
echo "installed: $APPIMAGE_FILE ($(du -h "$APPIMAGE_FILE" | cut -f1)), sha256 $(sha256sum "$APPIMAGE_FILE" | cut -c1-16)"

step "package $NEXT as the update"
run bump-next.log npm version "$NEXT" --no-git-tag-version
run build-next.log npm run build
NEXT_HASH="$(sha256sum dist/main/host.js | cut -c1-12)"
echo "the update's genie-host: $NEXT_HASH"
if [ "$NEXT_HASH" != "$BASE_HASH" ]; then echo '### client-only=NOT-CLIENT-ONLY'; fail "the two builds carry different hosts ($BASE_HASH, $NEXT_HASH)"; fi
run package-next.log npx electron-builder --linux AppImage --publish never --config "$FEED_CONFIG"
mv -f package.json.pristine package.json
mv -f package-lock.json.pristine package-lock.json
next_image="$(ls release/*"$NEXT"*.AppImage 2>/dev/null | head -1)"
[ -n "$next_image" ] || { ls -la release; fail "no $NEXT AppImage in release/"; }
NEXT_SHA="$(sha256sum "$next_image" | cut -d' ' -f1)"
[ -f release/latest-linux.yml ] || fail 'no release/latest-linux.yml'
run feed-host.log node scripts/feed-host-identity.mjs release/latest-linux.yml
grep -q "genieHostHash: '$BASE_HASH'" release/latest-linux.yml || fail 'latest-linux.yml does not name the host'
grep -q "version: $NEXT" release/latest-linux.yml || fail "latest-linux.yml does not name $NEXT"
echo 'latest-linux.yml:'; cat release/latest-linux.yml

step 'serve the feed'
node scripts/serve-feed.mjs release 8099 >feed.log 2>&1 &
FEED_PID=$!
sleep 2
curl -fsS -o /dev/null -w 'feed answers: %{http_code} %{size_download} bytes\n' "${FEED_URL}latest-linux.yml" || fail 'the feed does not answer'

step "launch the installed $BASE and drive the update"
export GENIE2_CODEX_BINARY="$ROOT/scripts/stub-codex.mjs" GENIE_PAGE_PROBE=1
# STREAMING THROUGH THE INSTALL (Tynn #1036 P6-1): the stub provider in TICKER mode, by a marker holding this script's pid, and
# where the agent's ledger stood when install was asked, written by update-cdp.mjs.
printf '%s' "$$" >"$TICKER"
export UPDATE_TICKS_FILE="$ROOT/update-ticks.json"
rm -f "$UPDATE_TICKS_FILE"
run seed.log node scripts/smoke-seed.mjs
"$APPIMAGE_FILE" --remote-debugging-port=9222 >installed-out.log 2>installed-err.log &
APP_PID=$!
host_before=''
for _ in $(seq 1 45); do sleep 2; p="$(host_pid)"; if alive "$p"; then host_before="$p"; break; fi; done
[ -n "$host_before" ] || { tail -40 installed-err.log; fail 'no live genie-host recorded in host.json before the update'; }
host_before_at="$(started_at "$host_before")"
host_exe="$(readlink "/proc/$host_before/exe")"
echo "genie-host before the update: pid $host_before, started $host_before_at, runs $host_exe"
case "$host_exe" in "$GHOME"/host/*) ;; *) fail "genie-host does not run from its copy under $GHOME/host/ (it runs $host_exe)" ;; esac
EXPECT_VERSION="$NEXT" node scripts/update-cdp.mjs
drive=$?
stubs_before="$(stub_pids)"
echo "agent providers when install was asked: ${stubs_before:-none}"
if [ "$drive" -ne 0 ]; then
    echo '--- installed stderr ---'; tail -120 installed-err.log
    echo '--- feed ---'; tail -20 feed.log
    fail "update-cdp.mjs exited $drive"
fi
# THE ROW'S BREAK PROBE: the stream interrupted during the install (its provider ended), which the row must fail on.
if [ "${UPDATE_TICKS_BREAK:-}" = stop-provider ]; then
    for p in $stubs_before; do echo "BREAK PROBE: ending the provider, pid $p, during the install"; kill -9 "$p" 2>/dev/null; done
fi

step "the window quits, the updater replaces the AppImage with $NEXT, the window comes back"
replaced=''
for _ in $(seq 1 90); do sleep 2; [ "$(sha256sum "$APPIMAGE_FILE" 2>/dev/null | cut -d' ' -f1)" = "$NEXT_SHA" ] && { replaced=1; break; }; done
[ -n "$replaced" ] || { tail -40 "$GHOME/logs/genie-updater.log" 2>/dev/null; tail -40 "$HOST_LOG" 2>/dev/null; fail "$APPIMAGE_FILE is not $NEXT's after 180 s"; }
echo "installed now: $NEXT ($APPIMAGE_FILE is $NEXT's AppImage)"
relaunched=''
for _ in $(seq 1 30); do
    sleep 2
    relaunched="$(pgrep -f "^$APPIMAGE_FILE" | grep -vx "$APP_PID" | head -1 || true)"
    [ -n "$relaunched" ] && break
done
[ -n "$relaunched" ] || fail 'the updated window did not come back'
echo "the window came back: pid $relaunched, started $(started_at "$relaunched")"
alive "$APP_PID" && fail "the base window (pid $APP_PID) is still running"

# THE CONVERSATION, CONTINUING: the updater starts the window with no debugger port, so that window is ended (genie-host and
# its providers run from the host's copy, not from the AppImage) and $NEXT opened again with one, over the same host.
step "the agent's ledger, in a window of $NEXT"
for p in $(window_pids); do kill -9 "$p" 2>/dev/null; done
sleep 3
"$APPIMAGE_FILE" --remote-debugging-port=9222 >viewer-out.log 2>viewer-err.log &
node scripts/update-ticks-after-cdp.mjs || { tail -40 viewer-err.log; fail "the agent's stream did not run through the install"; }

# THE ROW (Tynn #413): the same host, and the same agent, through the update.
sleep 15
host_after="$(host_pid)"
alive "$host_after" || fail 'no live genie-host recorded in host.json after the update'
host_after_at="$(started_at "$host_after")"
echo "genie-host after the update: pid $host_after, started $host_after_at"
if [ "$host_after" != "$host_before" ] || [ "$host_after_at" != "$host_before_at" ]; then
    tail -30 "$HOST_LOG" 2>/dev/null
    fail "genie-host changed: pid $host_before before, $host_after after"
fi
stubs_after="$(stub_pids)"
echo "agent providers after the update: ${stubs_after:-none} (before: ${stubs_before:-none})"
[ -n "$stubs_before" ] || fail 'no agent provider was running when install was asked'
for p in $stubs_before; do alive "$p" || fail "agent provider pid $p did not keep running through the update"; done
for p in $stubs_after; do case " $stubs_before " in *" $p "*) ;; *) fail "agent provider pid $p was started again: the agent was restarted, not kept" ;; esac; done
said="$(grep -h 'only the window is updated, so this host stays' "$HOST_LOG" "$GHOME/runtime/lifecycle.log" 2>/dev/null | tail -1)"
[ -n "$said" ] || { tail -40 "$HOST_LOG"; fail 'genie-host did not log a client-only install'; }
echo "genie-host said: $said"
grep -h 'shutting down' "$HOST_LOG" && fail 'genie-host logged a shutdown'

step 'tear down'
echo
echo "CLIENT-ONLY UPDATE PROVEN (Linux AppImage): $BASE -> $NEXT, genie-host pid $host_before and the agent kept running through it"
echo '### client-only=PASS'
