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
# Each row is a step of a Linux job of the removed .github/workflows/ci.yml, run with the same command and time limit, and
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
#   - flows and zip64 run only when the change touches them (the owner: Flows acceptance "only when we make changes to
#     flows"), read from ci-changed.txt: the changed paths, one per line, as `git diff --name-only <base>...HEAD` prints
#     them, written by the caller (the shipped tree has no .git). With no ci-changed.txt both run: the safe default.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
OUT="$PWD/ci-out"
# What the setup writes goes under ci-out/setup, never beside the rows' own logs (windows.ps1's build row failed on that).
SETUP="$OUT/setup"

# The rows, in ci.yml's order: `typecheck + unit`, then `a real window`, then the acceptance jobs.
ROWS=(
    deps electron-binary
    typecheck unit build bundles sounds
    seed no-pty smoke layout local-door-break local-door host-late-ready files-watch chat-drafts gapp-open artboard ui-lag
    trust-step site-panel site-panel-locked browser-process spawn-host safe-mode hang renderer-crash
    flows zip64 host-plain-node mailpit
    package package-fuse
)

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
# THE SETUP A SHORT RUN STANDS ON, RUN FIRST AND SAID (as windows.ps1; the targeted Azure run failed three rows on a
# missing Electron binary that the skipped rows used to fetch): deps and electron-binary first, and build when a chosen
# row needs the built app, each with its own ROW line.
if [ -n "$only$from" ]; then
    setup=(deps electron-binary)
    for r in "${selected[@]}"; do
        case " deps electron-binary typecheck unit flows zip64 host-plain-node mailpit " in *" $r "*) ;; *) setup+=(build); break ;; esac
    done
    rest=()
    for r in "${selected[@]}"; do case " ${setup[*]} " in *" $r "*) ;; *) rest+=("$r") ;; esac; done
    selected=("${setup[@]}" "${rest[@]}")
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
    sudo pacman -S --needed --noconfirm "$pkg" >"$SETUP/pacman-$pkg.log" 2>&1 && return 0
    tail -20 "$SETUP/pacman-$pkg.log"
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
    npm ci --no-audit --no-fund >"$SETUP/npm-ci.log" 2>&1 || { tail -40 "$SETUP/npm-ci.log"; block "$installed_why"; return 1; }
    installed=ok
}

# ELECTRON'S BINARY. Electron 44 has no install script: `require('electron')` fetches the binary the first time something
# asks for its path, and row scripts that start node_modules/electron/dist/electron by its path never ask. Fetched here
# with the package's own install.js (checksum-checked), and its absence said by name.
ELECTRON_BIN="$PWD/node_modules/electron/dist/electron"
electron_ok=''
electron_why=''
need_electron() {
    if [ -n "$electron_ok" ]; then [ "$electron_ok" = ok ] && return 0; blocked="$electron_why"; return 1; fi
    electron_ok=failed
    need_install || { electron_why="$blocked"; return 1; }
    [ -x "$ELECTRON_BIN" ] || node node_modules/electron/install.js >"$SETUP/electron-install.log" 2>&1 || tail -5 "$SETUP/electron-install.log"
    if [ ! -x "$ELECTRON_BIN" ]; then
        electron_why="$ELECTRON_BIN missing (node_modules/electron/install.js did not fetch it: see ci-out/setup/electron-install.log)"
        block "$electron_why"; return 1
    fi
    echo "--- Electron: $ELECTRON_BIN ($(du -m "$ELECTRON_BIN" | cut -f1) MB)"
    electron_ok=ok
}

built=''
built_why=''
need_build() {
    if [ -n "$built" ]; then [ "$built" = ok ] && return 0; blocked="$built_why"; return 1; fi
    built=failed
    built_why='the build failed'
    need_install || { built_why="$blocked"; return 1; }
    need_electron || { built_why="$blocked"; return 1; }
    echo "--- npm run build"
    npm run build >"$SETUP/build.log" 2>&1 || { tail -40 "$SETUP/build.log"; block "$built_why"; return 1; }
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

# HOW THIS MACHINE DRAWS, SAID ONCE. ui-lag and artboard have absolute time bounds set on a machine that keeps up at
# idle. A virtual machine with no GPU does not: omarchy-test's idle pass alone sits at those bounds. There the two rows
# still run and print every number, and judge their ABSOLUTE bounds against the same run's idle pass (the coordinator's
# ruling, 2026-11-11); their within-run ratios and byte budgets are judged as everywhere. GENIE_CI_RENDERING=software
# is that statement: set here when the machine is a VM with no 3D render node, or given by whoever starts the run.
# A machine with a GPU gets the absolute budgets.
declare_rendering() {
    if [ -n "${GENIE_CI_RENDERING:-}" ]; then echo "--- rendering: $GENIE_CI_RENDERING (given)"; return 0; fi
    local virt nodes
    virt="$(systemd-detect-virt --vm 2>/dev/null || true)"
    nodes="$(ls /dev/dri/renderD* 2>/dev/null | tr '\n' ' ')"
    if [ -n "$virt" ] && [ "$virt" != none ] && [ -z "$nodes" ]; then
        export GENIE_CI_RENDERING=software
        notes+=("MEASURED ON A SOFTWARE-RENDERED MACHINE (a $virt VM with no render node): ui-lag and artboard judged their absolute time bounds against this run's idle pass, not the absolute budgets; their idle figures are in ci-out/ui-lag.log and ci-out/artboard.log")
    else
        export GENIE_CI_RENDERING=hardware
    fi
    echo "--- rendering: $GENIE_CI_RENDERING (virtualisation: ${virt:-none}; render nodes: ${nodes:-none})"
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
    declare_rendering
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
#
# A HOME OF ITS OWN, AND NOTHING LEFT FROM BEFORE (Tynn #692; the coordinator's loop of `--only smoke`, 8 runs in one
# omarchy-test session: run 1 passed, runs 2-8 failed, starting with 14 electron processes and a genie-host still alive
# from the run before. This script's cleanup ended only `npx`, not the app under it nor the genie-host it starts, which
# outlives its window by design; and the app used the machine's own ~/.genie, so the next run opened on the last run's
# state, or found the old app still holding Genie's single-instance lock and debugger port). Now:
#   - the app gets a new home for every run (HOME and XDG_CONFIG_HOME, so ~/.genie and Electron's own profile), and the
#     seed is written there, every run;
#   - before it starts, and before every row that starts an app of its own, anything Genie's that an earlier run or row
#     left alive is ended, and checked gone; what was found is said, by pid and command;
#   - at the end the app, every process under it, and its genie-host (by the pid its host.json names) are ended and
#     checked gone.
APP_PID=''
SAMPLER_PID=''
APP_HOME=''
app=''
app_why=''

# Every pid under these pids, them included.
tree_of() {
    ps -e -o pid=,ppid= | awk -v roots="$*" 'BEGIN { n = split(roots, r, " "); for (i = 1; i <= n; i++) keep[r[i]] = 1 }
        { parent[$1] = $2; pids[NR] = $1 }
        END { changed = 1; while (changed) { changed = 0; for (i in pids) { p = pids[i]; if (!(p in keep) && (parent[p] in keep)) { keep[p] = 1; changed = 1 } } }
              for (p in keep) print p }'
}
# The shared app's own processes: the app's tree, and its genie-host's (it is started detached, outside the app's tree).
app_tree() {
    local roots="" hostpid=""
    [ -n "$APP_PID" ] && roots="$APP_PID"
    if [ -n "$APP_HOME" ] && [ -f "$APP_HOME/.genie/runtime/host.json" ]; then
        hostpid="$(node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (Number.isInteger(j.pid)) console.log(j.pid) } catch {}' "$APP_HOME/.genie/runtime/host.json")"
        [ -n "$hostpid" ] && roots="$roots $hostpid"
    fi
    [ -n "$roots" ] && tree_of $roots
}
# Genie's processes alive now: Electron from this checkout, a genie-host from any home's copy, the host bundle on Node.
genie_processes() {
    pgrep -f -- "$PWD/node_modules/electron/|/\.genie/host/|dist/main/host\.js|genie-host" 2>/dev/null | grep -vx "$$" || true
}
# End what an earlier run or row left, except the shared app while it is needed; say what it was; check it is gone.
reap_leftovers() {
    local why="$1" keep pids p
    keep=" $(app_tree | tr '\n' ' ') "
    pids=""
    for p in $(genie_processes); do case "$keep" in *" $p "*) ;; *) pids="$pids $p" ;; esac; done
    [ -n "$pids" ] || return 0
    echo "REAPED before $why: $(echo $pids | wc -w) process(es) an earlier run or row left alive:"
    for p in $pids; do echo "  $p $(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-200)"; done
    notes+=("before $why, $(echo $pids | wc -w) Genie process(es) left alive by an earlier run or row were ended (see REAPED in ci-out/$why.log)")
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        local alive=""
        for p in $pids; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
        [ -z "$alive" ] && return 0
        sleep 1
    done
    kill -9 $pids 2>/dev/null || true
    sleep 1
    local left=""
    for p in $pids; do kill -0 "$p" 2>/dev/null && left="$left $p"; done
    [ -z "$left" ] || { block "Genie processes from before would not end:$left"; return 1; }
}

need_app() {
    if [ -n "$app" ]; then [ "$app" = ok ] && return 0; blocked="$app_why"; return 1; fi
    app=failed
    need_build && need_display || { app_why="$blocked"; return 1; }
    reap_leftovers "the app" || { app_why="$blocked"; return 1; }
    if curl -fsS -m 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
        app_why='something already answers on the debugger port 9222 (an app this run did not start)'
        block "$app_why"; return 1
    fi
    # NODE, RESOLVED UNDER THE REAL HOME FIRST (the gate on candidate 10347329: with HOME moved, mise's shims refused,
    # "Config files ... are not trusted", because mise keeps its trust record under the real home). The real binary's
    # directory goes first on the app's PATH, so the seed, the stub codex's `#!/usr/bin/env node` and anything the app
    # starts find node without a shim; Electron is started by its own path, not through npx. Nothing is trusted anew.
    local node_bin
    node_bin="$( (command -v mise >/dev/null 2>&1 && mise which node 2>/dev/null) || readlink -f "$(command -v node)")"
    if [ ! -x "$node_bin" ]; then app_why="node could not be resolved to its own binary (got '$node_bin')"; block "$app_why"; return 1; fi
    local app_path="$(dirname "$node_bin"):$PATH"
    APP_HOME="$(mktemp -d /tmp/genie-ci-app-XXXXXX)"
    echo "--- the app's own home: $APP_HOME; node: $node_bin ($("$node_bin" --version))"
    HOME="$APP_HOME" XDG_CONFIG_HOME="$APP_HOME/.config" PATH="$app_path" "$node_bin" scripts/smoke-seed.mjs >"$SETUP/seed.out" 2>&1 || { tail -20 "$SETUP/seed.out"; app_why="the seed could not be written: $(tail -1 "$SETUP/seed.out" | cut -c1-160)"; block "$app_why"; return 1; }
    chmod +x scripts/stub-codex.mjs
    # Ordinary provider configuration, exactly as ci.yml sets it for this launch: codex is the stub, so a REAL parked
    # approval reaches the screen on a machine with no codex.
    HOME="$APP_HOME" XDG_CONFIG_HOME="$APP_HOME/.config" PATH="$app_path" GENIE2_CODEX_BINARY="$PWD/scripts/stub-codex.mjs" GENIE_PAGE_PROBE=1 \
        on_display "$ELECTRON_BIN" . --no-sandbox --remote-debugging-port=9222 >"$OUT/electron.log" 2>&1 &
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

# The shared app, everything under it and its genie-host, ended and checked gone: the next run starts clean.
stop_app() {
    local pids p left
    pids="$(app_tree | tr '\n' ' ')"
    [ -n "${pids// /}" ] || return 0
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        left=""
        for p in $pids; do kill -0 "$p" 2>/dev/null && left="$left $p"; done
        [ -z "$left" ] && break
        sleep 1
    done
    [ -n "$left" ] && { kill -9 $left 2>/dev/null || true; sleep 1; }
    left=""
    for p in $pids; do kill -0 "$p" 2>/dev/null && left="$left $p"; done
    wait "$APP_PID" 2>/dev/null || true
    if [ -n "$left" ]; then echo "APP LEFT ALIVE after the stop:$left"; else echo "--- the app and its genie-host are gone ($(echo $pids | wc -w) process(es) ended)"; fi
}
cleanup() { stop_app; }
trap cleanup EXIT

# --- the rows: each prints nothing itself and returns ci.yml's step status --------------------------------------------

row_deps() { need_install; }
row_electron-binary() { need_electron; }
row_typecheck() { need_install && npm run typecheck; }
# The suite, and every test's time beside it (ci.yml's Windows job does the same): ci-out/slow-tests.tsv is ms, status,
# file, test, slowest first. The table is observe only; the row's result is the suite's.
#
# HOW MANY FILES AT ONCE (Tynn #692). Vitest runs one worker per core less one. On omarchy-test that starved the suite:
# a different test fell over its 5 s limit in three of four runs (5.0 s, 5.8 s; its neighbours took 4 to 567 ms), with
# 18 to 36 s tests running beside it, and the row took 340 s one run and 556 s another. A worker here is more than one
# core's work: these tests start git by the hundred, real ptys, hosts on Electron's binary and 512 MB files of their own.
# THE RULE: three eighths of the machine's cores, and never fewer than two (3 on omarchy-test's 8: measured green at 3,
# 608 s, where 4 failed in three runs of five). CI_UNIT_WORKERS=<n> overrides it for a measurement.
# No test's time limit is touched. The row prints the machine, the count it used, and the load it saw (a 1-minute load
# above the core count is a machine with more to run than cores to run it on), so the rule is checked by every run.
# DOCKER, AS GitHub'S RUNNER HAD IT: its daemon running and this user allowed to talk to it. Some unit tests read a real
# `docker events` stream (test/host-owns-docker-events.test.ts), and the Mailpit measure runs a container. Said in the
# run's output either way; started with systemctl when it is installed and not running. Nothing is installed here.
docker_state=''
say_docker() {
    [ -n "$docker_state" ] && { echo "$docker_state"; return; }
    local answer
    if ! command -v docker >/dev/null 2>&1; then docker_state='DOCKER not installed on this machine'; echo "$docker_state"; return; fi
    if ! answer="$(docker info --format '{{.ServerVersion}}' 2>&1)"; then
        echo "--- docker does not answer ($(tail -1 <<<"$answer" | cut -c1-160)); starting its service"
        sudo systemctl start docker >/dev/null 2>&1 || true
        answer="$(docker info --format '{{.ServerVersion}}' 2>&1)" || { docker_state="DOCKER does not answer for user $(id -un) (service: $(systemctl is-active docker 2>&1)): $(tail -1 <<<"$answer" | cut -c1-160)"; echo "$docker_state"; return; }
        docker_state="DOCKER server $answer, started by this run (service was not running)"
    else
        docker_state="DOCKER server $answer, already running"
    fi
    echo "$docker_state"
}

unit_workers() {
    local cores="$1"
    if [ -n "${CI_UNIT_WORKERS:-}" ]; then echo "$CI_UNIT_WORKERS"; return; fi
    local n=$((cores * 3 / 8))
    [ "$n" -lt 2 ] && n=2
    echo "$n"
}
row_unit() {
    need_install && need_electron || return 1
    local code=0 cores workers sampler
    cores="$(nproc)"
    workers="$(unit_workers "$cores")"
    echo "UNIT machine: $cores cores, $(awk '/MemTotal/ { printf "%d MB", $2 / 1024 }' /proc/meminfo); vitest's own count would be $((cores > 1 ? cores - 1 : 1)) workers; running with $workers (${CI_UNIT_WORKERS:+CI_UNIT_WORKERS, }3/8 of the cores, at least 2)"
    say_docker
    : >"$OUT/unit-load.tsv"
    ( while :; do echo "$(date +%s) $(cut -d' ' -f1-4 /proc/loadavg)" >>"$OUT/unit-load.tsv"; sleep 5; done ) &
    sampler=$!
    npm test -- "--maxWorkers=$workers" --reporter=default --reporter=json "--outputFile.json=$OUT/vitest-results.json" || code=$?
    kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
    awk -v cores="$cores" '{ n += 1; sum += $2; if ($2 > max) max = $2; if ($2 > cores) over += 1 } END { if (n) printf "UNIT load: 1-minute load average %.1f, highest %.1f, above the %d cores in %d of %d samples (5 s apart)\n", sum / n, max, cores, over, n; else print "UNIT load: not sampled" }' "$OUT/unit-load.tsv"
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
# A HOST READY LATE (Tynn #700): the host is started 25 s late on purpose; the window must still reach its page.
row_host-late-ready() { need_app && timeout 180 node scripts/host-late-ready-cdp.mjs; }
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
    local log="$APP_HOME/.genie/runtime/lifecycle.log"
    grep -h "spawn host" "$log" | tail -5 || true
    grep -q "spawn host ready pid=" "$log" || return 1
    if grep -q "spawn host could not start" "$log"; then return 1; fi
}
row_safe-mode() { need_build && need_display && on_display timeout 540 node scripts/safe-mode-cdp.mjs; }
row_hang() { need_build && need_display && on_display timeout 540 node scripts/hang-cdp.mjs; }
row_renderer-crash() { need_build && need_display && on_display timeout 420 node scripts/renderer-crash-cdp.mjs; }

# WHETHER THE CHANGE TOUCHES A SUITE. scripts/flows-paths.mjs and scripts/zip64-paths.mjs decide, from the code (every
# file the suite's subject is made of, by import, plus the suite, its config and the deciding script itself): the same
# decision ci.yml made. The list holds names only, so a changed package.json or package-lock.json counts as touching
# both (ci.yml read the diff for the fancy-flow and yazl lines; a name cannot say which line changed). No list: run.
CHANGED="$PWD/ci-changed.txt"
skip_reason=''
touches() {
    local script="$1" what="$2" hits
    if [ ! -f "$CHANGED" ]; then echo "--- no ci-changed.txt: $what runs (the safe default)"; return 0; fi
    echo "--- ci-changed.txt lists $(grep -c . "$CHANGED") changed path(s)"
    if grep -qxE 'package(-lock)?\.json' "$CHANGED"; then echo "--- package.json or package-lock.json changed: $what runs"; return 0; fi
    hits="$(node "$script" --touched "$CHANGED")" || { echo "--- $script could not decide: $what runs"; return 0; }
    if [ -n "$hits" ]; then echo "--- touches $what:"; echo "$hits"; return 0; fi
    skip_reason="no $what changes"
    return 1
}
row_flows() {
    need_install || return 1
    touches scripts/flows-paths.mjs Flows || return 0
    npm run verify:flows
}
row_zip64() {
    need_install || return 1
    touches scripts/zip64-paths.mjs 'zip writer' || return 0
    npm run verify:zip64
}

# GENIE-HOST ON PLAIN NODE, as ci.yml's job runs it: Node 22.16.0 exactly (the oldest whose node:sqlite has FTS5) and NO
# Electron binary, so anything in the host that reaches for Electron fails here instead of finding one. Its own copy of
# the tree and its own `npm ci` with ELECTRON_SKIP_BINARY_DOWNLOAD: the run's node_modules has Electron in it. Node
# 22.16.0 from mise, which Omarchy ships; a machine without mise cannot run this row and says so.
row_host-plain-node() {
    local dir="$OUT/plain-node" node_dir
    if ! command -v mise >/dev/null 2>&1; then blocked='mise is not on this machine, so Node 22.16.0 cannot be had'; return 1; fi
    mise install node@22.16.0 >"$SETUP/plain-node-mise.log" 2>&1 || { tail -20 "$SETUP/plain-node-mise.log"; blocked='mise could not install Node 22.16.0'; return 1; }
    node_dir="$(mise where node@22.16.0)/bin"
    rm -rf "$dir"
    mkdir -p "$dir"
    tar -C . --exclude=./node_modules --exclude=./dist --exclude=./ci-out --exclude=./release --exclude=./.git -cf - . | tar -C "$dir" -xf -
    (
        cd "$dir" || exit 1
        export PATH="$node_dir:$PATH"
        echo "node $(node --version), from $node_dir"
        [ "$(node --version)" = v22.16.0 ] || { echo "not Node 22.16.0"; exit 1; }
        ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund >npm-ci.log 2>&1 || { tail -40 npm-ci.log; exit 1; }
        npm run build:main || exit 1
        timeout 300 node scripts/host-plain-node-boot.mjs
    )
}

# THE MAILPIT MEASUREMENT: the Mailpit image Genie runs, from GHCR by digest, so Docker must answer for this user.
row_mailpit() {
    need_install || return 1
    say_docker
    case "$docker_state" in DOCKER\ server*) ;; *) blocked="$docker_state"; return 1 ;; esac
    npm run verify:mailpit
}

# IT PACKAGES: ci.yml's Linux leg of `it packages` (on a push there): the pinned Caddy fetched, the AppImage built with
# electron-builder, and the cookie fuse read from what was packaged. The Windows leg's checks run in windows.ps1.
row_package() {
    need_build || return 1
    npx tsx scripts/fetch-caddy.ts || return 1
    npx electron-builder --publish never
}
row_package-fuse() {
    local app
    app="$(ls -d release/linux-unpacked/[gG]enie* 2>/dev/null | head -1)"
    if [ -z "$app" ]; then blocked='nothing was packaged (release/linux-unpacked has no Genie binary): see the package row'; return 1; fi
    npx --yes @electron/fuses read --app "$app" | tee "$OUT/fuses.txt"
    grep -q "EnableCookieEncryption is Enabled" "$OUT/fuses.txt"
}

# THE MACHINE BEFORE EACH ROW (Tynn #692, omarchy-test run 8): hang and renderer-crash failed where run 3 passed, with
# genie-host's own clock jumping 9 to 12 s while it used 3 to 38 ms of CPU, and chat-drafts' 100 MiB read took 20.6 s
# where it took 3.3 s. A process that is not scheduled for 10 s is starved by something: memory (swap), the disk, the
# CPU, or the VM's own host. One line per row says which, from the kernel's pressure figures (the share of the last 10 s
# some task was stalled on each), free memory and swap, and the Genie processes still alive from earlier rows.
machine_line() {
    local psi=''
    for r in cpu memory io; do
        [ -r "/proc/pressure/$r" ] && psi+=" ${r}=$(awk '/^some/ { split($2, a, "="); print a[2] "%" }' "/proc/pressure/$r")"
    done
    printf 'MACHINE before %s: load %s, available %s MB, swap used %s MB, stalled in the last 10 s:%s, still alive: %s electron, %s genie-host, %s node\n' \
        "$1" "$(cut -d' ' -f1 /proc/loadavg)" \
        "$(awk '/^MemAvailable/ { printf "%d", $2 / 1024 }' /proc/meminfo)" \
        "$(awk '/^SwapTotal/ { t = $2 } /^SwapFree/ { f = $2 } END { printf "%d", (t - f) / 1024 }' /proc/meminfo)" \
        "${psi:- (no pressure figures)}" \
        "$(pgrep -c -x electron 2>/dev/null || true)" "$(pgrep -c -f 'genie-host|dist/main/host.js' 2>/dev/null || true)" "$(pgrep -c -x node 2>/dev/null || true)"
}

# EVERY ROW HAS A CEILING (Tynn #692: on the Azure Windows VM trust-step printed its title and then nothing until the
# job's 90 minutes ran out, and no row after it ran). In seconds: the row script's own timeout from ci.yml plus 60 s for
# the row's own steps, or its ci.yml job's time limit, or a stated one. On expiry the row's processes are ended (every
# process under this script, except the shared app's), the row prints `(timed out after N s)`, and the run goes on.
ceiling() {
    case "$1" in
        deps|host-plain-node|mailpit) echo 900 ;;
        electron-binary|package-fuse) echo 300 ;;
        typecheck|build) echo 600 ;;
        unit) echo 1800 ;;
        bundles|sounds|spawn-host) echo 60 ;;
        seed) echo 300 ;;
        no-pty|smoke|layout|local-door-break|local-door|gapp-open|trust-step) echo 360 ;;
        files-watch) echo 240 ;;
        chat-drafts|artboard) echo 420 ;;
        ui-lag|renderer-crash) echo 480 ;;
        site-panel) echo 340 ;;
        site-panel-locked) echo 180 ;;
        host-late-ready) echo 240 ;;
        browser-process) echo 320 ;;
        safe-mode|hang) echo 600 ;;
        flows|zip64) echo 1200 ;;
        package) echo 1500 ;;
        *) echo 600 ;;
    esac
}
# The watchdog: after the ceiling, it marks the row timed out and ends every process under this script but itself, the
# machine sampler's tree (Tynn #660) and the shared app's tree. The row's command then returns, failing, and the loop reads the mark.
watchdog() {
    local name="$1" limit="$2" mark="$3" token="$4" s
    # Its sleep ends with it, and never holds the gate's output (Tynn issue #709): a sleep left behind by a killed
    # watchdog kept an SSH-run gate open until the longest ceiling had passed.
    sleep "$limit" >/dev/null 2>&1 </dev/null &
    s=$!
    trap 'kill "$s" 2>/dev/null; exit 0' TERM
    wait "$s" || return 0
    printf '%s\n' "$token" >"$mark"
    local keep p
    keep=" $BASHPID $(tree_of "$SAMPLER_PID" | tr '\n' ' ') $(app_tree | tr '\n' ' ') "
    for p in $(tree_of $$); do
        [ "$p" = "$$" ] && continue
        case "$keep" in *" $p "*) continue ;; esac
        kill -9 "$p" 2>/dev/null || true
    done
}

# --- run them ---------------------------------------------------------------------------------------------------------

mkdir -p "$OUT" "$SETUP"
# THE MACHINE BESIDE EVERY ROW (Tynn #660): scripts/ci/machine-sampler.sh writes one MACHINE line every ~2 s for the
# whole run into ci-out/machine-samples.log, and ends with this script. The watchdog spares it (SAMPLER_PID).
MACHINE_SAMPLES="$OUT/machine-samples.log"
infra=()
bash scripts/ci/machine-sampler.sh "$MACHINE_SAMPLES" "$$" >/dev/null 2>&1 </dev/null &
SAMPLER_PID=$!
# THE MACHINE'S TWO CLOCKS, read before and after: a test VM restored from a snapshot has its wall clock corrected while
# it runs, and a row that times something by the wall clock can then read a time that never passed. Said, not judged.
clock_wall() { date +%s.%N; }
clock_mono() { cut -d' ' -f1 /proc/uptime; }
wall0="$(clock_wall)"; mono0="$(clock_mono)"
echo "CI LINUX rows: ${selected[*]}"

# >>> THE ROW LOOP (test/ci-infra-rerun-linux.test.ts runs this block, as it is, with stub rows)
#
# STALL-AWARE ROWS (Tynn #660; the owner: "we are wasting so much time on failing test infrastructure"). A row that
# FAILS while the machine sampler recorded a stall during it (scripts/ci/stall.mjs: the disk waiting with the CPU idle,
# every task stalled on io, the hypervisor stealing the CPU, or the VM paused) is INFRA: said, and run ONCE more on this
# machine; its ROW line is the rerun's, marked INFRA, and the summary names it. A row that fails with no stall is never
# run again: its failure is the code's. A row an earlier row's need stopped (`not run`) is not its own failure, and is
# not run again either. What stall.mjs found, or that it found nothing in N samples, is printed under the failure.
now_ms() { date +%s%3N; }
machine_stall() { node scripts/ci/stall.mjs "$MACHINE_SAMPLES" "$1" "$2"; }

# The needs a row can set. One that FAILED during a row is asked again by its rerun, never read from that failure.
NEED_STATES=(installed electron_ok built display_ready keyring_ready app)
needs_before=()
needs_snapshot() { local v; needs_before=(); for v in "${NEED_STATES[@]}"; do needs_before+=("${!v}"); done; }
needs_reset_failed_here() {
    local i v
    for i in "${!NEED_STATES[@]}"; do
        v="${NEED_STATES[$i]}"
        if [ "${!v}" != "${needs_before[$i]}" ] && [ "${!v}" != ok ]; then
            [ "$v" = app ] && stop_app
            printf -v "$v" '%s' "${needs_before[$i]}"
        fi
    done
}

# ONE RUN OF ONE ROW, its output appended to ci-out/<name>.log and the end of it printed when it fails. Sets row_verdict
# (PASS, FAIL or SKIP), row_line (its ROW line, printed by run_rows) and row_own (0 when an earlier row's need stopped it).
run_row() {
    local name="$1" started=$SECONDS limit mark token watch_pid row_status timed_out
    blocked=''
    blocked_here=''
    skip_reason=''
    row_own=1
    limit="$(ceiling "$name")"
    mark="$SETUP/timed-out-$name"
    # This row's own token (windows.ps1 read a list as a timeout once): a mark that is not this row's is not a timeout.
    token="$name-$$-$RANDOM-$SECONDS"
    rm -f -- "$mark"
    watchdog "$name" "$limit" "$mark" "$token" &
    watch_pid=$!
    row_status=0
    "row_$name" >>"$OUT/$name.log" 2>&1 || row_status=$?
    # A ROW THAT ENDS BEFORE ITS CEILING CANNOT READ AS TIMED OUT: the mark holds this row's token, and the time passed.
    timed_out=''
    if [ -f "$mark" ] && [ "$(cat -- "$mark")" = "$token" ] && [ $((SECONDS - started)) -ge $((limit - 5)) ]; then timed_out=1; fi
    if [ "$row_status" = 0 ] && [ -z "$timed_out" ]; then
        kill "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null
        grep -E '^(UNIT|DOCKER|UI_LAG MEASURED|ARTBOARD MEASURED) ' "$OUT/$name.log" || true
        if [ -n "$skip_reason" ]; then
            # Not needed by this change: said as such, and neither a pass nor a fail.
            row_verdict=SKIP; row_line="ROW $name SKIP ($skip_reason)"
        else
            row_verdict=PASS; row_line="ROW $name PASS $((SECONDS - started))"
        fi
    elif [ -n "$timed_out" ]; then
        wait "$watch_pid" 2>/dev/null
        echo "--- the end of ci-out/$name.log"
        tail -40 "$OUT/$name.log"
        row_verdict=FAIL; row_line="ROW $name FAIL $((SECONDS - started)) (timed out after $limit s)"
    elif [ -n "$blocked" ]; then
        kill "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null
        # It could not run: what it needed failed, and the words are that need's, said once in the first row that met it.
        if [ -n "$blocked_here" ]; then
            echo "--- the end of ci-out/$name.log"
            tail -40 "$OUT/$name.log"
        else
            row_own=0
        fi
        row_verdict=FAIL; row_line="ROW $name FAIL $((SECONDS - started)) (not run: $blocked)"
    else
        kill "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null
        echo "--- the end of ci-out/$name.log"
        tail -60 "$OUT/$name.log"
        if [ "$app" = ok ] && [ -f "$OUT/electron.log" ]; then
            echo "--- the end of ci-out/electron.log"
            tail -30 "$OUT/electron.log"
        fi
        grep -E '^(UNIT|DOCKER|UI_LAG MEASURED|ARTBOARD MEASURED) ' "$OUT/$name.log" || true
        row_verdict=FAIL; row_line="ROW $name FAIL $((SECONDS - started))"
    fi
}

run_rows() {
    local name from stall stalled
    for name in "${selected[@]}"; do
        echo "=== $name"
        machine_line "$name"
        case " local-door-break local-door files-watch chat-drafts gapp-open artboard ui-lag trust-step site-panel site-panel-locked browser-process safe-mode hang renderer-crash host-late-ready package-fuse " in
            *" $name "*) reap_leftovers "$name" ;;
        esac
        from="$(now_ms)"
        needs_snapshot
        : >"$OUT/$name.log"
        run_row "$name"
        if [ "$row_verdict" = FAIL ] && [ "$row_own" = 1 ]; then
            stalled=0
            stall="$(machine_stall "$from" "$(now_ms)")" && stalled=1
            echo "$stall"
            if [ "$stalled" = 1 ]; then
                local secs="${row_line#ROW "$name" FAIL }"
                echo "INFRA $name FAIL ${secs%% *}: the machine stalled during the row ($(head -1 <<<"$stall")); running it once more on this machine"
                printf '\n=== INFRA: the machine stalled during the run above; the rerun follows\n' >>"$OUT/$name.log"
                needs_reset_failed_here
                run_row "$name"
                if [ "$row_verdict" != FAIL ]; then
                    echo "$row_line (INFRA: the first run failed during a machine stall; the rerun passed)"
                    infra+=("$name (rerun PASS)")
                else
                    echo "$row_line (INFRA: the first run failed during a machine stall; the rerun failed too)"
                    infra+=("$name (rerun FAIL)")
                    failed+=("$name")
                fi
                continue
            fi
        fi
        echo "$row_line"
        [ "$row_verdict" = FAIL ] && failed+=("$name")
    done
    return 0
}

infra_summary() {
    if [ "${#infra[@]}" -gt 0 ]; then echo "INFRA ROWS: ${infra[*]}"; else echo "INFRA ROWS: none"; fi
}
# <<< THE ROW LOOP

run_rows

stop_app
kill "$SAMPLER_PID" 2>/dev/null
left_at_end="$(genie_processes | tr '\n' ' ')"
[ -n "${left_at_end// /}" ] && notes+=("Genie processes still alive at the end of the run: $left_at_end")
for n in "${notes[@]}"; do echo "NOTE $n"; done
infra_summary
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
if [ "${#failed[@]}" -gt 0 ]; then
    echo "FAILED ROWS: ${failed[*]}"
    echo "CI LINUX FAIL"
    exit 1
fi
echo "CI LINUX PASS"
