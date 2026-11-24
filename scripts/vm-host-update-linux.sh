#!/usr/bin/env bash
# vm-host-update-linux.sh — A HOST UPDATE DRAINS AND SWAPS ON LINUX, PROVEN (Tynn #1036 P6-2, task #1499; the CI row `host-update`).
#
# The Linux twin of scripts/vm-windows-update.ps1. Needs a test machine (user `genie`, or GENIE_TEST_MACHINE=1), its Hyprland
# session (the window rows' display), FUSE (an AppImage mounts itself), and this checkout with `npm ci` run:
#
#   bash scripts/vm-host-update-linux.sh [base] [next]        (default 2.0.0 2.0.1)
#
# The installed Genie is an AppImage at ~/Applications/Genie.AppImage, a name with no version in it, so electron-updater
# replaces that file in place. Both builds are packaged with a `generic` feed at http://127.0.0.1:8099/ (the AppImage's
# app-update.yml is inside its read-only image, so it is written at packaging). $NEXT is built with GENIE_TEST_HOST_MARK
# (vite.main.config.ts; nothing that ships sets it), so it carries ANOTHER genie-host, and latest-linux.yml names that host
# (scripts/feed-host-identity.mjs, as the release does): the installed Genie classifies the update full. With the seeded agent
# running when install is asked, the row:
#
#   the host logged a full install ("this host exits"); the drain recorded the agent in running-at-quit.json before the old
#   host was gone; the old genie-host and every agent provider from before are gone; a NEW genie-host runs the update's host
#   (its host.js under ~/.genie/host/<the update's hash>, its binary the copied runtime, and it logs the update's mark); the
#   base's copy is gone; the agent came back exactly once, under the new host, and the record is spent; the AppImage is $NEXT's.
#
# Break probes (HOST_UPDATE_BREAK, or host-update-break.txt at the root):
#   client-only   the update is built with no mark (the same host): the row must fail on the kept host.
#   drop-restore  the drain's record is emptied while the updater runs: the row must fail on the agent that did not come back.
#
# If the two builds' hosts are the same with no probe asking for it: `### host-update=NOT-A-HOST-UPDATE`.
# Prints `### host-update=PASS` at the end; a failure prints `### host-update=FAIL <why>` and exits 1.
set -uo pipefail
BASE="${1:-2.0.0}"
NEXT="${2:-2.0.1}"
ROOT="$(pwd)"
LOG="$ROOT/host-update-linux.log"
exec > >(tee "$LOG") 2>&1
APPS="$HOME/Applications"
APPIMAGE_FILE="$APPS/Genie.AppImage"
GHOME="$HOME/.genie"
HOST_RECORD="$GHOME/runtime/host.json"
HOST_LOG="$GHOME/logs/genie-host.log"
LIFECYCLE="$GHOME/runtime/lifecycle.log"
RUNNING_AT_QUIT="$GHOME/runtime/running-at-quit.json"
INTERRUPTED_AT_QUIT="$GHOME/runtime/interrupted-at-quit.json"
FEED_URL='http://127.0.0.1:8099/'
FEED_PID=''
APP_PID=''
BREAK="${HOST_UPDATE_BREAK:-}"
[ -z "$BREAK" ] && [ -f host-update-break.txt ] && BREAK="$(tr -d '[:space:]' <host-update-break.txt)"
[ -n "$BREAK" ] && echo "BREAK PROBE asked: $BREAK"
# A DEBUGGER PORT OF ITS OWN: no other row uses it (test/ci-debug-ports-unique.test.ts); the driver checks the page is this run's launch.
DEBUG_PORT=9416
export CDP_PORT="$DEBUG_PORT"
port_free() { ! curl -fsS -m 3 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1 || fail "something already answers on this row's debugger port $DEBUG_PORT (not this run's Genie)"; }

step() { echo; echo "=== $* ==="; }
fail() { echo "### host-update=FAIL $*"; exit 1; }
run() { local log="$1"; shift; "$@" >"$log" 2>&1 || { tail -40 "$log"; fail "FAILED: $*"; }; }

cleanup() {
    [ -n "$FEED_PID" ] && kill "$FEED_PID" 2>/dev/null
    # Pass or fail, what the run started goes: its windows, genie-host from its copy, the providers.
    end_all
    [ -f package.json.pristine ] && mv -f package.json.pristine package.json
    [ -f package-lock.json.pristine ] && mv -f package-lock.json.pristine package-lock.json
    rm -f "$ROOT/electron-builder.host-update-feed.json"
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
# An AppImage mounts itself with FUSE; electron-builder's AppImage runtime loads libfuse.so.2 (measured, 1123-201245-948f6a).
if { ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; } || ! ldconfig -p 2>/dev/null | grep -q 'libfuse[.]so[.]2'; then
    echo "no fusermount or no libfuse.so.2: installing fuse2"
    # The VM's package database is not synced (measured, 1123-205944-a119e0): -Sy for it.
    if ! sudo -n pacman -Sy --needed --noconfirm fuse2 >fuse-install.log 2>&1; then
        tail -20 fuse-install.log
        echo 'FUSE 2 could not be installed: the AppImage runs with APPIMAGE_EXTRACT_AND_RUN=1 (not a FUSE mount)'
        export APPIMAGE_EXTRACT_AND_RUN=1
    fi
fi
[ -n "${APPIMAGE_EXTRACT_AND_RUN:-}" ] || [ -e /dev/fuse ] || fail 'no /dev/fuse: an AppImage cannot mount itself here'

started_at() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//'; }
host_pid() { node -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(r.pid ?? "") } catch { console.log("") }' "$HOST_RECORD"; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
cmdline() { tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null; }
stub_pids() { pgrep -f 'stub-codex\.mjs' | sort -n | tr '\n' ' ' | sed 's/ $//'; }
# How many ids a JSON array file holds; none when there is no file.
ids_in() { node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length) } catch { console.log(0) }' "$1"; }
# Whether $1 is $2 or started under it, by the parent pids (bounded: a chain is never this long).
descends() {
    local at="$1"
    for _ in $(seq 1 16); do
        [ "$at" = "$2" ] && return 0
        at="$(ps -o ppid= -p "$at" 2>/dev/null | tr -d ' ')"
        { [ -z "$at" ] || [ "$at" -le 1 ]; } && return 1
    done
    return 1
}
# Every Genie process of this run: what runs from an AppImage mount, the AppImage runtimes, and the host's copy.
genie_pids() {
    for p in /proc/[0-9]*; do
        exe="$(readlink "$p/exe" 2>/dev/null)" || continue
        case "$exe" in /tmp/.mount_*|/tmp/appimage_extracted_*|"$GHOME"/host/*) echo "${p#/proc/}" ;; esac
    done
    pgrep -f "^$APPIMAGE_FILE" || true
}
end_all() { for p in $(genie_pids) $(pgrep -f 'stub-codex\.mjs'); do kill -9 "$p" 2>/dev/null; done; sleep 2; }

cp -f package.json package.json.pristine
cp -f package-lock.json package-lock.json.pristine
# The packaging config with the local feed as its publish target, whole: electron-builder merges a `-c.publish.*` override
# into the github block and its schema refuses that for `generic` (measured, 1123-192745).
FEED_CONFIG="$ROOT/electron-builder.host-update-feed.json"
node -e '
const fs = require("fs");
let yaml; try { yaml = require("js-yaml"); } catch { yaml = null; }
const text = fs.readFileSync("electron-builder.yml", "utf8");
const config = yaml ? yaml.load(text) : require("yaml").parse(text);
config.publish = { provider: "generic", url: process.argv[1] };
fs.writeFileSync(process.argv[2], JSON.stringify(config, null, 2));
' "$FEED_URL" "$FEED_CONFIG" || fail 'the packaging config with the local feed could not be written'

# --- the base: packaged, "installed" -----------------------------------------------------------------------------------
step "package $BASE and install it"
end_all
rm -rf release "$GHOME"
run bump-base.log npm version "$BASE" --no-git-tag-version --allow-same-version
# The base carries no mark.
unset GENIE_TEST_HOST_MARK
run build-base.log npm run build
BASE_HASH="$(sha256sum dist/main/host.js | cut -c1-12)"
echo "the base build's genie-host: $BASE_HASH"
# A BUILD MADE AS ONE THAT SHIPS (no GENIE_TEST_HOST_MARK) CARRIES NO MARK: its host.js has no row mark in it.
grep -qF 'host-update-' dist/main/host.js && fail 'the base build, made with no mark, carries a host-update mark in host.js'
run package-base.log npx electron-builder --linux AppImage --publish never --config "$FEED_CONFIG"
base_image="$(ls release/*"$BASE"*.AppImage 2>/dev/null | head -1)"
[ -n "$base_image" ] || { ls -la release; fail "no $BASE AppImage in release/"; }
mkdir -p "$APPS"
cp -f "$base_image" "$APPIMAGE_FILE"
chmod +x "$APPIMAGE_FILE"
echo "installed: $APPIMAGE_FILE, sha256 $(sha256sum "$APPIMAGE_FILE" | cut -c1-16)"

step "package $NEXT as the update, with another genie-host"
if [ "$BREAK" = client-only ]; then MARK=''; else MARK="host-update-$NEXT"; fi
run bump-next.log npm version "$NEXT" --no-git-tag-version
GENIE_TEST_HOST_MARK="$MARK" run build-next.log npm run build
NEXT_HASH="$(sha256sum dist/main/host.js | cut -c1-12)"
echo "the update's genie-host: $NEXT_HASH (mark '$MARK')"
# The control for the base's absence: the same search finds the mark in a build made with one.
if [ -n "$MARK" ] && ! grep -qF "$MARK" dist/main/host.js; then fail "the update's host.js does not carry its mark '$MARK'"; fi
if [ "$NEXT_HASH" = "$BASE_HASH" ] && [ "$BREAK" != client-only ]; then echo '### host-update=NOT-A-HOST-UPDATE'; fail "the two builds carry the same host ($BASE_HASH): the mark did not reach host.js"; fi
run package-next.log npx electron-builder --linux AppImage --publish never --config "$FEED_CONFIG"
mv -f package.json.pristine package.json
mv -f package-lock.json.pristine package-lock.json
next_image="$(ls release/*"$NEXT"*.AppImage 2>/dev/null | head -1)"
[ -n "$next_image" ] || { ls -la release; fail "no $NEXT AppImage in release/"; }
NEXT_SHA="$(sha256sum "$next_image" | cut -d' ' -f1)"
[ -f release/latest-linux.yml ] || fail 'no release/latest-linux.yml'
run feed-host.log node scripts/feed-host-identity.mjs release/latest-linux.yml
grep -q "genieHostHash: '$NEXT_HASH'" release/latest-linux.yml || fail "latest-linux.yml does not name the update's host $NEXT_HASH"
grep -q "version: $NEXT" release/latest-linux.yml || fail "latest-linux.yml does not name $NEXT"
echo 'latest-linux.yml:'; cat release/latest-linux.yml

step 'serve the feed'
node scripts/serve-feed.mjs release 8099 >feed.log 2>&1 &
FEED_PID=$!
fed=''
for _ in $(seq 1 30); do sleep 2; curl -fsS -o /dev/null "${FEED_URL}latest-linux.yml" 2>/dev/null && { fed=1; break; }; done
[ -n "$fed" ] || { cat feed.log; fail 'the feed does not answer'; }

step "launch the installed $BASE and drive the update"
export GENIE2_CODEX_BINARY="$ROOT/scripts/stub-codex.mjs" GENIE_PAGE_PROBE=1
unset UPDATE_TICKS_FILE
# THE SEED'S WORKSPACE IS A NEW DIRECTORY, NEVER THE CHECKOUT (the full gate 1124-020718-168937).
WORKSPACE="$(mktemp -d -t genie-host-update-workspace-XXXXXX)"
( cd "$WORKSPACE" && node "$ROOT/scripts/smoke-seed.mjs" ) >seed.log 2>&1 || { tail -20 seed.log; fail "the seed failed in $WORKSPACE"; }
port_free
"$APPIMAGE_FILE" --remote-debugging-port="$DEBUG_PORT" >installed-out.log 2>installed-err.log &
APP_PID=$!
host_before=''
for _ in $(seq 1 45); do sleep 2; p="$(host_pid)"; if alive "$p"; then host_before="$p"; break; fi; done
[ -n "$host_before" ] || { tail -40 installed-err.log; fail 'no live genie-host recorded in host.json before the update'; }
host_before_cmd="$(cmdline "$host_before")"
echo "genie-host before the update: pid $host_before, started $(started_at "$host_before"): $host_before_cmd"
case "$host_before_cmd" in *"/host/$BASE_HASH/dist/main/host.js"*) ;; *) fail "the base genie-host does not run the base's copy (host/$BASE_HASH): $host_before_cmd" ;; esac
# THE PROVIDERS ARE SAMPLED WHILE THE DRIVER RUNS, never after it: a full install drains at once, so by the time
# update-cdp.mjs exits they are already gone (measured, 1124-081929-7eb671: none found after it, on both platforms, while
# the client-only probe, whose agent is kept, found its provider).
( while :; do pgrep -f 'stub-codex\.mjs'; sleep 0.5; done ) >stub-samples.txt 2>/dev/null &
SAMPLER=$!
EXPECT_VERSION="$NEXT" CDP_OWN_PID="$APP_PID" node scripts/update-cdp.mjs
drive=$?
kill "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null
stubs_before="$(sort -nu stub-samples.txt | tr '\n' ' ' | sed 's/ $//')"
echo "agent providers when install was asked: ${stubs_before:-none}"
if [ "$drive" -ne 0 ]; then
    echo '--- installed stderr ---'; tail -120 installed-err.log
    echo '--- feed ---'; tail -20 feed.log
    fail "update-cdp.mjs exited $drive"
fi
[ -n "$stubs_before" ] || fail 'no agent provider was running when install was asked: there is nothing for the drain to carry'

step 'the drain: the old host records who comes back, and goes'
for _ in $(seq 1 150); do alive "$host_before" || break; sleep 1; done
alive "$host_before" && { tail -40 "$HOST_LOG"; fail "the old genie-host pid $host_before did not exit within 150 s of the install"; }
echo "the old genie-host pid $host_before is gone"
[ -f "$RUNNING_AT_QUIT" ] || fail "the drain wrote no $RUNNING_AT_QUIT"
at_quit="$(ids_in "$RUNNING_AT_QUIT")"
echo "the drain's record of who comes back: $(cat "$RUNNING_AT_QUIT") ($at_quit)"
[ "$at_quit" -ge 1 ] || fail 'the drain recorded no agent to come back'
if [ "$BREAK" = drop-restore ]; then echo 'BREAK PROBE: the drain record emptied while the updater runs'; printf '[]' >"$RUNNING_AT_QUIT"; printf '[]' >"$INTERRUPTED_AT_QUIT"; fi

step "the updater replaces the AppImage with $NEXT, the window comes back"
replaced=''
for _ in $(seq 1 90); do sleep 2; [ "$(sha256sum "$APPIMAGE_FILE" 2>/dev/null | cut -d' ' -f1)" = "$NEXT_SHA" ] && { replaced=1; break; }; done
[ -n "$replaced" ] || { tail -40 "$GHOME/logs/genie-updater.log" 2>/dev/null; tail -40 "$HOST_LOG" 2>/dev/null; fail "$APPIMAGE_FILE is not $NEXT's after 180 s"; }
echo "installed now: $NEXT"
relaunched=''
for _ in $(seq 1 30); do
    sleep 2
    relaunched="$(pgrep -f "^$APPIMAGE_FILE" | grep -vx "$APP_PID" | head -1 || true)"
    [ -n "$relaunched" ] && break
done
[ -n "$relaunched" ] || fail 'the updated window did not come back'
echo "the window came back: pid $relaunched, started $(started_at "$relaunched")"

step "the swap: a new genie-host, from the update's copy"
host_after=''
for _ in $(seq 1 45); do sleep 2; p="$(host_pid)"; if [ "$p" != "$host_before" ] && alive "$p"; then host_after="$p"; break; fi; done
[ -n "$host_after" ] || host_after="$(host_pid)"
alive "$host_after" || { tail -40 "$HOST_LOG"; fail 'no live genie-host recorded in host.json after the update'; }
host_after_cmd="$(cmdline "$host_after")"
host_after_exe="$(readlink "/proc/$host_after/exe")"
echo "genie-host after the update: pid $host_after, started $(started_at "$host_after"), runs $host_after_exe: $host_after_cmd"
[ "$host_after" != "$host_before" ] || fail "genie-host is still pid $host_before: the update did not swap the host"
alive "$host_before" && fail "the old genie-host pid $host_before is running again"
said="$(grep -h 'updater: it has the install; this host exits' "$HOST_LOG" "$LIFECYCLE" 2>/dev/null | tail -1)"
[ -n "$said" ] || { tail -40 "$HOST_LOG"; fail 'genie-host did not log a full install'; }
echo "the old host said: $said"
case "$host_after_cmd" in *"/host/$NEXT_HASH/dist/main/host.js"*) ;; *) fail "the new genie-host does not run the update's copy (host/$NEXT_HASH): $host_after_cmd" ;; esac
case "$host_after_exe" in "$GHOME"/host/runtime-*-host/genie-host) ;; *) fail "the new genie-host does not run from the copied runtime: $host_after_exe" ;; esac
[ -n "$MARK" ] || fail 'the update carries no mark: the new host cannot say which code it is'
grep -q "host build mark: $MARK" "$GHOME/runtime/lifecycle.log" || fail "the new genie-host did not say the update's mark '$MARK'"
echo "the new host said: $(grep -h "host build mark: $MARK" "$LIFECYCLE" | tail -1)"
[ -e "$GHOME/host/$BASE_HASH" ] && fail "the base's copy host/$BASE_HASH is still there"

step 'the agent: drained, and back exactly once, under the new host'
revived=''
for _ in $(seq 1 30); do
    sleep 2
    for p in $(stub_pids); do case " $stubs_before " in *" $p "*) ;; *) revived="$p" ;; esac; done
    [ -n "$revived" ] && break
done
# Time for a second start to show, if there is one.
sleep 10
stubs_now="$(stub_pids)"
echo "agent providers now: ${stubs_now:-none} (before: $stubs_before)"
for p in $stubs_before; do alive "$p" && fail "agent provider pid $p survived the update"; done
revived_n=0
for p in $stubs_now; do case " $stubs_before " in *" $p "*) ;; *) revived_n=$((revived_n + 1)); revived="$p" ;; esac; done
[ "$revived_n" -eq 1 ] || fail "the agent that was running came back $revived_n times (want exactly 1)"
descends "$revived" "$host_after" || fail "the agent came back as pid $revived, not under the new genie-host $host_after"
spent="$(ids_in "$RUNNING_AT_QUIT")"
[ "$spent" -eq 0 ] || fail "the drain's record still names $spent agent(s) after the restore: $(cat "$RUNNING_AT_QUIT")"

step 'tear down'
echo
echo "HOST UPDATE PROVEN (Linux AppImage): $BASE -> $NEXT, genie-host $host_before ($BASE_HASH) drained and replaced by $host_after ($NEXT_HASH), the agent back once"
echo '### host-update=PASS'
