#!/usr/bin/env bash
#
# GENIE'S LINUX CI, ON OUR OWN MACHINE (Tynn issue #692; the owner, 2026-11-11: "ALL CI IS LOCAL OR IN AZURE").
#
#   bash scripts/ci/linux.sh                      every row, in ci.yml's order
#   bash scripts/ci/linux.sh --only unit,smoke    only these rows (what they need is prepared first)
#   bash scripts/ci/linux.sh --from local-door    this row and every row after it
#   bash scripts/ci/linux.sh --list               the row names, in order
#
# Run it on an Omarchy machine from a clean checkout, inside its Hyprland session (WAYLAND_DISPLAY set): the envelope's
# `scripts/omarchy-run.sh <repo-dir> 'bash scripts/ci/linux.sh'` does exactly that on the omarchy-test VM. NEVER on a
# person's desktop: the rows open real windows, start real hosts and write to ~/.genie.
#
# Each row is a step of a Linux job in .github/workflows/ci.yml, run with the same command and the same time limit, and
# it passes or fails on the same thing. One line per row, `ROW <name> PASS|FAIL <seconds>`, then `CI LINUX PASS|FAIL`;
# the exit status is non-zero when any row failed. A row's whole output is in ci-out/<name>.log, and the end of it is
# printed when the row fails. A failed row does not stop the run: every later row still reports.
#
# WHERE IT DIFFERS FROM ci.yml, and why:
#   - The window opens on the Hyprland session, not on Xvfb: that is what the owner's machines run. CI_DISPLAY=xvfb puts
#     every window on a 1440x900 virtual X screen instead, as ci.yml did, to tell a row that fails on Hyprland's window
#     size from one that fails on the product.
#   - scripts/smoke-fonts.conf is not installed: it exists for a bare image whose `system-ui` resolves to a monospace
#     face. An Omarchy desktop has its own fonts, and they are what a person sees.
#   - Nothing is installed with apt. A command a row needs and the machine lacks is installed with pacman, that package
#     only (never -Syu: Omarchy refuses a direct system upgrade).
#   - flows and zip64 always run: ci.yml skips them when a change touches neither, and here there is no base to compare.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
OUT="$PWD/ci-out"

# The rows, in ci.yml's order: `typecheck + unit`, then `a real window`, then the acceptance jobs.
ROWS=(
    typecheck unit build bundles sounds
    seed no-pty smoke layout local-door-break local-door files-watch chat-drafts gapp-open artboard ui-lag
    trust-step site-panel site-panel-locked browser-process spawn-host safe-mode hang renderer-crash
    flows zip64
)
# Linux jobs of ci.yml this script does not run yet. Named in the last line, so a PASS never reads as all of CI.
NOT_YET=(host-plain-node mailpit package)

only=''
from=''
while [ $# -gt 0 ]; do
    case "$1" in
        --only) only="${2:?--only <row,row>}"; shift 2 ;;
        --from) from="${2:?--from <row>}"; shift 2 ;;
        --list) printf '%s\n' "${ROWS[@]}"; exit 0 ;;
        *) echo "usage: linux.sh [--only <row,row>] [--from <row>] [--list]" >&2; exit 64 ;;
    esac
done

known() { local r; for r in "${ROWS[@]}"; do [ "$r" = "$1" ] && return 0; done; return 1; }
selected=()
if [ -n "$only" ]; then
    IFS=',' read -r -a asked <<<"$only"
    for r in "${asked[@]}"; do known "$r" || { echo "no such row: $r (see --list)" >&2; exit 64; }; done
    # In ci.yml's order, whatever order they were asked in.
    for r in "${ROWS[@]}"; do for a in "${asked[@]}"; do [ "$r" = "$a" ] && selected+=("$r"); done; done
elif [ -n "$from" ]; then
    known "$from" || { echo "no such row: $from (see --list)" >&2; exit 64; }
    seen=0
    for r in "${ROWS[@]}"; do [ "$r" = "$from" ] && seen=1; [ "$seen" = 1 ] && selected+=("$r"); done
else
    selected=("${ROWS[@]}")
fi

failed=()
notes=()

# --- what a row needs, prepared once, and only when a selected row needs it -------------------------------------------
#
# A need that failed says why ONCE, in `blocked`, and every row that needed it carries those words on its ROW line:
# `ROW layout FAIL 0 (not run: ...)`. A row that could not run is not a row that ran and failed.
blocked=''
blocked_here=''
block() { blocked="$1"; blocked_here=1; echo "--- $1"; return 1; }

# A command the rows shell out to, and the Arch package that has it. Installed only when the command is missing.
need_cmd() {
    local cmd="$1" pkg="$2"
    command -v "$cmd" >/dev/null 2>&1 && return 0
    echo "--- $cmd is missing: installing $pkg with pacman"
    sudo pacman -S --needed --noconfirm "$pkg" >"$OUT/pacman-$pkg.log" 2>&1 && return 0
    tail -20 "$OUT/pacman-$pkg.log"
    block "$cmd is missing and pacman could not install $pkg"
}

installed=''
installed_why=''
need_install() {
    if [ -n "$installed" ]; then [ "$installed" = ok ] && return 0; blocked="$installed_why"; return 1; fi
    installed=failed
    installed_why='npm ci failed'
    echo "--- node $(node --version 2>&1), npm $(npm --version 2>&1), $(grep -m1 PRETTY_NAME /etc/os-release 2>/dev/null)"
    need_cmd git git || { installed_why="$blocked"; return 1; }
    # `npm ci`, with scripts: Electron's binary is the point of the window rows.
    echo "--- npm ci"
    npm ci --no-audit --no-fund >"$OUT/npm-ci.log" 2>&1 || { tail -40 "$OUT/npm-ci.log"; block "$installed_why"; return 1; }
    installed=ok
}

built=''
built_why=''
need_build() {
    if [ -n "$built" ]; then [ "$built" = ok ] && return 0; blocked="$built_why"; return 1; fi
    built=failed
    built_why='the build failed'
    need_install || { built_why="$blocked"; return 1; }
    echo "--- npm run build"
    npm run build >"$OUT/build.log" 2>&1 || { tail -40 "$OUT/build.log"; block "$built_why"; return 1; }
    built=ok
}

# A window, where this run puts windows: the Hyprland session, or a virtual X screen when asked.
on_display() {
    if [ "${CI_DISPLAY:-hyprland}" = xvfb ]; then
        xvfb-run --auto-servernum --server-args='-screen 0 1440x900x24' "$@"
    else
        "$@"
    fi
}

# THE SESSION'S OWN DISPLAY VARIABLES. Genie passes Electron no platform flag: Electron opens a Wayland window when the
# session says it is one (XDG_SESSION_TYPE=wayland), and an X11 one otherwise. A person's Hyprland session says so; a
# shell that came in over ssh says `tty`, and Electron then looks for an X server (omarchy-test, 2026-11-11: "Missing X
# server or $DISPLAY", with WAYLAND_DISPLAY set). So a shell that is not in the session takes these from the session
# itself, where uwsm put them for every app it starts: the user manager's environment. Only what picks and finds the
# display; not the session bus, so the app's keyring is what each row gives it, as before.
SESSION_VARS=(XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE)
take_session_display() {
    [ "${XDG_SESSION_TYPE:-}" = wayland ] && [ -n "${WAYLAND_DISPLAY:-}" ] && return 0
    local env line name
    env="$(systemctl --user show-environment 2>&1)" || { echo "--- the session's environment could not be read: $env"; return 0; }
    for name in "${SESSION_VARS[@]}"; do
        line="$(grep -m1 "^$name=" <<<"$env" || true)"
        [ -n "$line" ] || continue
        if [ "${!name:-}" != "${line#*=}" ]; then
            echo "--- from the session: $line (this shell had '${!name:-}')"
            export "$name=${line#*=}"
        fi
    done
}

# THIS IS A TEST MACHINE, SAID ONCE AND ONLY WHEN IT IS TRUE. The window rows open the real app, write to ~/.genie and
# end processes, so each row script refuses anywhere else. GENIE_TEST_MACHINE=1 is that statement, for every row: set
# here when the machine is one of ours by its own account (the test VMs' user is `genie`, which the row scripts already
# go by), or by the person who starts the run on another test machine. It is never assumed, and `CI=true` is not set:
# that was GitHub's word for itself.
declare_test_machine() {
    if [ "${GENIE_TEST_MACHINE:-}" = 1 ]; then echo "--- a test machine: GENIE_TEST_MACHINE=1 was given"; return 0; fi
    if [ "$(id -un)" = genie ]; then export GENIE_TEST_MACHINE=1; echo "--- a test machine: its user is genie"; return 0; fi
    return 1
}

display_ready=''
display_why=''
need_display() {
    if [ -n "$display_ready" ]; then [ "$display_ready" = ok ] && return 0; blocked="$display_why"; return 1; fi
    display_ready=failed
    if ! declare_test_machine; then
        display_why="not a test machine (user $(id -un)): the window rows run only on one; GENIE_TEST_MACHINE=1 says this machine is"
        block "$display_why"; return 1
    fi
    need_cmd pgrep procps-ng && need_cmd ss iproute2 && need_cmd curl curl || { display_why="$blocked"; return 1; }
    if [ "${CI_DISPLAY:-hyprland}" = xvfb ]; then
        need_cmd xvfb-run xorg-server-xvfb && need_cmd xauth xorg-xauth || { display_why="$blocked"; return 1; }
        echo "--- windows open on Xvfb, 1440x900 (CI_DISPLAY=xvfb)"
    else
        take_session_display
        if [ -z "${WAYLAND_DISPLAY:-}" ] || [ ! -S "${XDG_RUNTIME_DIR:-/nonexistent}/$WAYLAND_DISPLAY" ]; then
            display_why="no Hyprland session: WAYLAND_DISPLAY='${WAYLAND_DISPLAY:-}', XDG_RUNTIME_DIR='${XDG_RUNTIME_DIR:-}'"
            block "$display_why"; return 1
        fi
        if [ "${XDG_SESSION_TYPE:-}" != wayland ]; then
            display_why="the session does not say it is Wayland (XDG_SESSION_TYPE='${XDG_SESSION_TYPE:-}'), so Electron would look for an X server"
            block "$display_why"; return 1
        fi
        echo "--- windows open on the Hyprland session: XDG_SESSION_TYPE=$XDG_SESSION_TYPE WAYLAND_DISPLAY=$WAYLAND_DISPLAY DISPLAY=${DISPLAY:-} XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-}"
    fi
    display_ready=ok
}

keyring_ready=''
keyring_why=''
need_keyring() {
    if [ -n "$keyring_ready" ]; then [ "$keyring_ready" = ok ] && return 0; blocked="$keyring_why"; return 1; fi
    keyring_ready=failed
    need_cmd gnome-keyring-daemon gnome-keyring && need_cmd dbus-run-session dbus || { keyring_why="$blocked"; return 1; }
    keyring_ready=ok
}

# THE APP, OPENED ONCE, as ci.yml's "open the app and drive it" does: the rows from `no-pty` to `ui-lag` drive this one
# window over the Chrome DevTools Protocol on port 9222. It stays open until the run ends. The `seed` row is this: the
# seed written and the app answering on its debugger port. An app that ended, or never answered, is said here once, with
# its own last words, and the rows that drive it are not run.
APP_PID=''
app=''
app_why=''
need_app() {
    if [ -n "$app" ]; then [ "$app" = ok ] && return 0; blocked="$app_why"; return 1; fi
    app=failed
    need_build && need_display || { app_why="$blocked"; return 1; }
    if [ ! -f "$OUT/seed.done" ]; then
        node scripts/smoke-seed.mjs >"$OUT/seed.out" 2>&1 || { tail -20 "$OUT/seed.out"; app_why='the seed could not be written'; block "$app_why"; return 1; }
        : >"$OUT/seed.done"
    fi
    chmod +x scripts/stub-codex.mjs
    # Ordinary provider configuration, exactly as ci.yml sets it for this launch: codex is the stub, so a REAL parked
    # approval reaches the screen on a machine with no codex.
    GENIE2_CODEX_BINARY="$PWD/scripts/stub-codex.mjs" GENIE_PAGE_PROBE=1 \
        on_display npx electron . --no-sandbox --remote-debugging-port=9222 >"$OUT/electron.log" 2>&1 &
    APP_PID=$!
    echo "--- the app is starting (pid $APP_PID); its output is in ci-out/electron.log"
    local waited=0
    until curl -fsS -m 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; do
        if ! kill -0 "$APP_PID" 2>/dev/null; then
            app_why="the app ended before it opened a window: $(grep -v '^$' "$OUT/electron.log" | tail -1 | cut -c1-200)"
            block "$app_why"; return 1
        fi
        if [ "$waited" -ge 90 ]; then
            app_why='the app did not answer on its debugger port (9222) within 90 s'
            block "$app_why"; return 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
    echo "--- the app answers on 9222 after ${waited} s"
    app=ok
}

cleanup() {
    if [ -n "$APP_PID" ]; then
        kill "$APP_PID" 2>/dev/null || true
        wait "$APP_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# --- the rows: each prints nothing itself and returns ci.yml's step status --------------------------------------------

row_typecheck() { need_install && npm run typecheck; }
# The suite, and every test's time beside it (ci.yml's Windows job does the same): ci-out/slow-tests.tsv is ms, status,
# file, test, slowest first. The table is observe only; the row's result is the suite's.
row_unit() {
    need_install || return 1
    local code=0
    npm test -- --reporter=default --reporter=json "--outputFile.json=$OUT/vitest-results.json" || code=$?
    node scripts/ci/slow-tests.mjs "$OUT/vitest-results.json" "$OUT/slow-tests.tsv" || true
    return "$code"
}
row_build() { need_build; }

# ci.yml's "the bundles exist, and are the right shape", command for command.
row_bundles() {
    need_build || return 1
    (
        set -euo pipefail
        test -f dist/renderer/index.html
        test -f dist/main/entry.js
        test -f dist/main/main.js
        test -f dist/main/staging-acl-worker.js
        test -f dist/main/doctor.js
        test -f dist/main/preload.cjs
        test -f dist/main/doctor-preload.cjs
        test -f dist/renderer/doctor.html
        grep -q "require(" dist/main/preload.cjs
        ! grep -qE "^import .* from" dist/main/preload.cjs
        ! grep -qE '(src|href)="/' dist/renderer/index.html
        ! grep -qE '(src|href)="/' dist/renderer/doctor.html
        css="dist/renderer/$(grep -m1 -oE 'assets/[^"]+\.css' dist/renderer/index.html)"
        test -f "$css"
        grep -q "150px_minmax" "$css"
        grep -q "280px" "$css"
        grep -q "30px" "$css"
    )
}
row_sounds() { need_build && node scripts/sound-assets-check.mjs dist/renderer src/renderer/sounds; }

row_seed() { need_app; }
row_no-pty() { need_app && GENIE2_CODEX_BINARY="$PWD/scripts/stub-codex.mjs" GENIE_PAGE_PROBE=1 timeout 300 node scripts/agents-hold-no-pty-cdp.mjs; }
row_smoke() { need_app && GENIE2_CODEX_BINARY="$PWD/scripts/stub-codex.mjs" GENIE_PAGE_PROBE=1 timeout 300 node scripts/smoke-cdp.mjs; }
row_layout() { need_app && GENIE2_CODEX_BINARY="$PWD/scripts/stub-codex.mjs" GENIE_PAGE_PROBE=1 timeout 300 node scripts/layout-sweep.mjs; }

# THE ADMISSION BREAK CONTROL: the door's own check, broken on purpose, must FAIL row 1 with the refusal's words.
# A control that passes, or fails some other way, is this row's failure.
row_local-door-break() {
    need_app && need_keyring || return 1
    local code=0
    timeout 300 dbus-run-session -- bash scripts/with-test-keyring.sh node scripts/local-door-cdp.mjs --break-admission >"$OUT/local-door-break.out" 2>&1 || code=$?
    cat "$OUT/local-door-break.out"
    [ "$code" -eq 1 ] && grep -q 'FAIL 1:' "$OUT/local-door-break.out" && grep -q 'actual refusal:.*not an admitted' "$OUT/local-door-break.out"
}
# Exit 2 is "some rows could not be measured here": ci.yml records that as INCOMPLETE and does not fail the job on it.
row_local-door() {
    need_app && need_keyring || return 1
    local code=0
    timeout 300 dbus-run-session -- bash scripts/with-test-keyring.sh node scripts/local-door-cdp.mjs || code=$?
    if [ "$code" -eq 2 ]; then
        notes+=("local-door is INCOMPLETE (exit 2): see the UNMEASURED rows in ci-out/local-door.log")
        return 0
    fi
    return "$code"
}
row_files-watch() { need_app && timeout 180 node scripts/files-watch-cdp.mjs; }
row_chat-drafts() { need_app && timeout 360 node scripts/chat-drafts-cdp.mjs; }
row_gapp-open() { need_app && timeout 300 node scripts/gapp-open-cdp.mjs; }
row_artboard() { need_app && timeout 360 node scripts/artboard-cdp.mjs --trace-main; }
row_ui-lag() { need_app && timeout 420 node scripts/ui-lag-cdp.mjs --budget; }

# These start the app themselves, on a home and ports of their own.
row_trust-step() { need_build && need_display && on_display timeout 300 node scripts/trust-step-cdp.mjs; }
row_site-panel() { need_app && need_keyring && timeout 280 dbus-run-session -- bash scripts/with-test-keyring.sh node scripts/site-panel-cdp.mjs; }
row_site-panel-locked() { need_app && SITE_PANEL_LOCKED=1 CDP_PORT=9336 timeout 120 node scripts/site-panel-cdp.mjs; }
row_browser-process() { need_app && need_keyring && timeout 260 dbus-run-session -- bash scripts/with-test-keyring.sh node scripts/browser-process-cdp.mjs; }
# The app opened by need_app wrote this log: the spawn host started, and never fell back.
row_spawn-host() {
    need_app || return 1
    grep -h "spawn host" ~/.genie/runtime/lifecycle.log | tail -5 || true
    grep -q "spawn host ready pid=" ~/.genie/runtime/lifecycle.log || return 1
    if grep -q "spawn host could not start" ~/.genie/runtime/lifecycle.log; then return 1; fi
}
row_safe-mode() { need_build && need_display && on_display timeout 540 node scripts/safe-mode-cdp.mjs; }
row_hang() { need_build && need_display && on_display timeout 540 node scripts/hang-cdp.mjs; }
row_renderer-crash() { need_build && need_display && on_display timeout 420 node scripts/renderer-crash-cdp.mjs; }

row_flows() { need_install && npm run verify:flows; }
row_zip64() { need_install && npm run verify:zip64; }

# --- run them ---------------------------------------------------------------------------------------------------------

mkdir -p "$OUT"
# THE MACHINE'S TWO CLOCKS, read before and after: a test VM restored from a snapshot has its wall clock corrected while
# it runs, and a row that times something by the wall clock can then read a time that never passed. Said, not judged.
clock_wall() { date +%s.%N; }
clock_mono() { cut -d' ' -f1 /proc/uptime; }
wall0="$(clock_wall)"; mono0="$(clock_mono)"
echo "CI LINUX rows: ${selected[*]}"
for name in "${selected[@]}"; do
    started=$SECONDS
    echo "=== $name"
    blocked=''
    blocked_here=''
    if "row_$name" >"$OUT/$name.log" 2>&1; then
        echo "ROW $name PASS $((SECONDS - started))"
    elif [ -n "$blocked" ]; then
        # It could not run: what it needed failed, and the words are that need's, said once in the first row that met it.
        if [ -n "$blocked_here" ]; then
            echo "--- the end of ci-out/$name.log"
            tail -40 "$OUT/$name.log"
        fi
        echo "ROW $name FAIL $((SECONDS - started)) (not run: $blocked)"
        failed+=("$name")
    else
        echo "--- the end of ci-out/$name.log"
        tail -60 "$OUT/$name.log"
        if [ "$app" = ok ] && [ -f "$OUT/electron.log" ]; then
            echo "--- the end of ci-out/electron.log"
            tail -30 "$OUT/electron.log"
        fi
        echo "ROW $name FAIL $((SECONDS - started))"
        failed+=("$name")
    fi
done

for n in "${notes[@]}"; do echo "NOTE $n"; done
echo "CLOCK $(awk -v w0="$wall0" -v w1="$(clock_wall)" -v m0="$mono0" -v m1="$(clock_mono)" 'BEGIN { printf "the wall clock advanced %.1f s while %.1f s passed (a difference of %+.1f s)", w1 - w0, m1 - m0, (w1 - w0) - (m1 - m0) }')"
# TEST FILES THE UNIT SUITE DID NOT RUN HERE, each with its own reason: a file that runs on Windows only carries
# `// CI: WINDOWS ONLY (<reason>)` (test/ci-windows-only-files.test.ts holds that), and scripts/ci/windows.ps1 runs it.
while IFS= read -r line; do
    [ -n "$line" ] || continue
    file="${line%%:*}"
    reason="${line#*WINDOWS ONLY (}"
    reason="${reason%)*}"
    echo "NOT RUN ON LINUX ${file} (${reason})"
done < <(grep -rH '^// CI: WINDOWS ONLY (' test --include='*.test.ts' --include='*.test.tsx' | sort)
echo "NOT RUN BY THIS SCRIPT YET (still only in ci.yml): ${NOT_YET[*]}"
if [ "${#failed[@]}" -gt 0 ]; then
    echo "FAILED ROWS: ${failed[*]}"
    echo "CI LINUX FAIL"
    exit 1
fi
echo "CI LINUX PASS"
