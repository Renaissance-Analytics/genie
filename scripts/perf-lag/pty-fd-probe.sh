#!/usr/bin/env bash
# pty-fd-probe.sh — WHO HOLDS THE WINDOW'S SOCKET, AND WHAT OUTLIVES A KILLED GENIE (batch L4 bugs A and B, genie#1452).
#
# Batch L4: after vm-smoke ended Genie, 127.0.0.1:9222 (Chromium's DevTools listener) was still LISTENING, held as fd 65 by a
# fancy-pty-helper and its `bash -l`, both re-parented to init. This runs the REAL chain once and prints what is true at
# each stage, with the OS's own tools:
#
#   window (Electron, --remote-debugging-port=9222) -> genie-host -> its `terminals` spawn host -> fancy-pty-helper -> bash
#
#   stage 1  everything up, a Workspace terminal open (through the window, as a person opens one)
#   stage 2  the WINDOW's process group SIGKILLed (what vm-smoke's stop does first)
#   stage 3  genie-host and its spawn hosts SIGKILLed too (what vm-smoke's `pkill -f .../electron/dist/electron` also hits:
#            the host and the spawn hosts run on that very binary)
# At each stage: `ss -ltnp` for :9222, the process tree of everything involved, and every socket/pipe fd of each process
# with its close-on-exec flag — the fds that share 9222's socket inode are marked.
#
# RUN (inside omarchy-test only; from the root of a built tree):
#   npm ci && npm run build && bash scripts/perf-lag/pty-fd-probe.sh
# Output: stdout, plus smoke-out/pty-fd-probe/ (electron.log, cdp.mjs).
#
# Every step has a deadline; the whole run is capped at 300 s; whatever happens, the cleanup ends every process of this
# run (marked in its environment) and any fancy-pty-helper this run left re-parented to init, then their shells.
set -u
T0=$(date +%s)
say() { echo "[$(( $(date +%s) - T0 ))s] $*"; }
MARK="genie-pty-probe-$$-$T0"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"

[ "$(uname -s)" = Linux ] && [ "$(id -un)" = genie ] && [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] \
    || { echo "pty-fd-probe: REFUSING — this runs only inside omarchy-test" >&2; exit 3; }
[ -f package.json ] && [ -f scripts/smoke-seed.mjs ] && [ -d dist/main ] \
    || { echo "pty-fd-probe: run it from the root of a BUILT Genie tree (npm ci && npm run build): $PWD" >&2; exit 2; }

OUT="$PWD/smoke-out/pty-fd-probe"; mkdir -p "$OUT"
ELECTRON_BIN="$PWD/node_modules/electron/dist/electron"
EPID=""
CAP=""

# ------------------------------------------------------------------ cleanup: this run's processes, whatever happened
cleanup() {
    trap - EXIT TERM INT
    [ -n "$CAP" ] && kill "$CAP" 2>/dev/null
    say "cleanup"
    [ -n "$EPID" ] && kill -KILL -- "-$EPID" 2>/dev/null
    local killed=""
    for d in /proc/[0-9]*; do
        local p=${d#/proc/}
        [ "$p" = "$$" ] && continue
        # Only this user's processes: another user's environ is unreadable, and the `<` redirection would complain before
        # any 2>/dev/null applied (job 76 printed "Permission denied" for every root process).
        [ -O "$d" ] && [ -r "$d/environ" ] || continue
        if tr '\0' '\n' 2>/dev/null < "$d/environ" | grep -qx "GENIE_PTY_PROBE=$MARK"; then kill -KILL "$p" 2>/dev/null && killed="$killed $p"; fi
    done
    # A helper re-parented to init that started during this run (its env is its own, so the marker may not reach it).
    local run_secs=$(( $(date +%s) - T0 + 1 ))
    for p in $(ps -eo pid=,ppid=,etimes=,args= | awk -v s="$run_secs" '$2 == 1 && $3 <= s && /fancy-pty-helper/ { print $1 }'); do
        for c in $(ps -eo pid=,ppid= | awk -v h="$p" '$2 == h { print $1 }'); do kill -KILL "$c" 2>/dev/null && killed="$killed $c"; done
        kill -KILL "$p" 2>/dev/null && killed="$killed $p"
    done
    say "cleanup ended:${killed:- nothing left}"
    echo "### pty-fd-probe=done"
}
trap cleanup EXIT
trap 'say "TERM/INT received"; exit 1' TERM INT
( sleep 300; echo "### pty-fd-probe: the 300 s cap was reached"; kill -TERM $$ ) & CAP=$!

# ------------------------------------------------------------------ what each stage prints
listener_inode() {
    # 9222 = 0x2406; LISTEN = 0A; the inode is column 10 of /proc/net/tcp.
    awk '$2 ~ /:2406$/ && $4 == "0A" { print $10 }' /proc/net/tcp 2>/dev/null | head -1
}
fds_of() {
    local pid=$1 inode=$2 n=0
    [ -d "/proc/$pid" ] || { echo "  pid $pid: gone"; return; }
    echo "  pid $pid ppid $(awk '{ print $4 }' "/proc/$pid/stat" 2>/dev/null) pgid $(awk '{ print $5 }' "/proc/$pid/stat" 2>/dev/null): $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-150)"
    for f in "/proc/$pid"/fd/*; do
        local fd=${f##*/} target
        target=$(readlink "$f" 2>/dev/null) || continue
        case "$target" in socket:*|pipe:*) ;; *) continue ;; esac
        local flags cloexec=no mark=""
        flags=$(awk '/^flags:/ { print $2 }' "/proc/$pid/fdinfo/$fd" 2>/dev/null)
        [ -n "$flags" ] && (( 8#$flags & 8#2000000 )) && cloexec=yes
        [ -n "$inode" ] && [ "$target" = "socket:[$inode]" ] && mark="   <== :9222 LISTENER"
        if [ -n "$mark" ] || [ $n -lt 40 ]; then echo "    fd $fd -> $target cloexec=$cloexec$mark"; fi
        n=$((n + 1))
    done
    [ $n -gt 40 ] && echo "    ($n socket/pipe fds in all; the :9222 listener is always shown)"
}
involved() {
    # Everything on Genie's Electron binary, every fancy-pty-helper, and each helper's children.
    local pids
    pids=$(ps -eo pid=,args= | awk -v e="$ELECTRON_BIN" '(index($0, e) || /fancy-pty-helper/) && !/awk/ { print $1 }')
    for h in $(ps -eo pid=,args= | awk '/fancy-pty-helper/ && !/awk/ { print $1 }'); do
        pids="$pids $(ps -eo pid=,ppid= | awk -v h="$h" '$2 == h { print $1 }')"
    done
    echo $pids | tr ' ' '\n' | sort -nu | tr '\n' ' '
}
stage() {
    local name=$1 inode
    inode=$(listener_inode)
    echo
    echo "================================================================ $name"
    say "ss -ltnp 'sport = :9222' (listener inode: ${inode:-none})"
    timeout 10 ss -ltnpe 'sport = :9222' 2>&1 | sed 's/^/  /'
    say "the process tree (Genie's binary, pty helpers and their shells, with ancestry)"
    local pids; pids=$(involved)
    if [ -n "$pids" ]; then
        timeout 10 ps -o pid,ppid,pgid,sid,etimes,args --forest -p "$(echo $pids | tr ' ' ',')" 2>&1 | cut -c1-200 | sed 's/^/  /'
    else
        echo "  (none)"
    fi
    say "the socket/pipe fds of each (cloexec = the close-on-exec flag; the :9222 listener marked)"
    for p in $pids; do fds_of "$p" "$inode"; done
    # Anyone ELSE holding the listener (by inode, whatever its binary).
    if [ -n "$inode" ]; then
        for d in /proc/[0-9]*; do
            local p=${d#/proc/}
            case " $pids " in *" $p "*) continue ;; esac
            ls -l "$d/fd" 2>/dev/null | grep -q "socket:\[$inode\]" && { echo "  ALSO holding the listener:"; fds_of "$p" "$inode"; }
        done
    fi
}

# ------------------------------------------------------------------ the chain
[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ] && export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export XDG_SESSION_TYPE=x11 DISPLAY="${DISPLAY:-:0}"
export GENIE2_CODEX_BINARY="$PWD/scripts/stub-codex.mjs"
chmod +x scripts/stub-codex.mjs

say "step 1: seed (≤ 60 s)"
[ -e project.json ] || timeout 60 node scripts/smoke-seed.mjs || { say "seed failed"; exit 1; }

say "step 2: is :9222 free before we start?"
stage "STAGE 0 — before anything starts"

say "step 3: launch Genie (window on :9222), marked GENIE_PTY_PROBE=$MARK"
GENIE_PTY_PROBE="$MARK" GENIE_PAGE_PROBE=1 setsid npx electron . --no-sandbox --ozone-platform=x11 --remote-debugging-port=9222 >"$OUT/electron.log" 2>&1 < /dev/null &
EPID=$!

cat > "$OUT/cdp.mjs" <<'EOF'
// Opens ONE Workspace terminal through the window, as a person does, and types into it. Every wait bounded.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = (ms, what, p) => Promise.race([p, sleep(ms).then(() => { throw new Error(`deadline: ${what} (${ms / 1000} s)`); })]);
let page = null;
for (const end = Date.now() + 60_000; Date.now() < end && !page;) {
    try { page = (await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(2_000) })).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { /* not yet */ }
    if (!page) await sleep(500);
}
if (!page) { console.log('CDP: no window on :9222 within 60 s'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await deadline(10_000, 'the CDP socket', new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('CDP socket error')); }));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const f = JSON.parse(e.data); pending.get(f.id)?.(f); pending.delete(f.id); };
const evaluate = (expression, ms = 15_000) => deadline(ms, expression.slice(0, 60), new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); }))
    .then((f) => { if (f.result?.exceptionDetails) throw new Error(f.result.exceptionDetails.exception?.description ?? 'threw'); return f.result?.result?.value; });
for (const end = Date.now() + 60_000; Date.now() < end;) { if (await evaluate('typeof window.genieTest?.snapshot === "function" && document.readyState === "complete"').catch(() => false)) break; await sleep(500); }
const snap = await evaluate('window.genieTest.snapshot()');
const workspaceId = snap?.workspaces?.[0]?.id;
if (!workspaceId) { console.log('CDP: no workspace in the seed'); process.exit(1); }
const opened = await evaluate(`window.genieTest.terminals.open(${JSON.stringify(workspaceId)}, { cols: 80, rows: 24 })`, 30_000);
console.log(`CDP: terminal opened ${JSON.stringify(opened)}`);
await sleep(3_000);
await evaluate(`window.genieTest.terminals.write(${JSON.stringify(opened?.id)}, "echo pty-fd-probe $$\\r"); true`).catch((e) => console.log(`CDP: write: ${e.message}`));
await sleep(2_000);
ws.close();
process.exit(0);
EOF
say "step 4: open a Workspace terminal through the window (≤ 150 s)"
timeout 150 node "$OUT/cdp.mjs" 2>&1 | sed 's/^/  /'
sleep 2
stage "STAGE 1 — everything up, a terminal open"

say "step 5: SIGKILL the window's process group (pgid $EPID), as vm-smoke's stop does first"
kill -KILL -- "-$EPID" 2>/dev/null
EPID=""
sleep 3
stage "STAGE 2 — the window's group SIGKILLed; genie-host left as it is"

HOST=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$HOME/.genie/runtime/host.json" 2>/dev/null)
SPAWNS=$(ps -eo pid=,ppid=,args= | awk -v h="${HOST:-x}" '$2 == h && /spawn-host/ { print $1 }')
say "step 6: SIGKILL genie-host (${HOST:-none in host.json}) and its spawn hosts (${SPAWNS:-none}), as vm-smoke's pkill of the Electron binary also does"
[ -n "$HOST" ] && kill -KILL "$HOST" 2>/dev/null
for s in $SPAWNS; do kill -KILL "$s" 2>/dev/null; done
sleep 3
stage "STAGE 3 — window, host and spawn hosts all SIGKILLed: what is left"

say "step 7: 10 s later, still there?"
sleep 10
stage "STAGE 4 — 10 s after stage 3"
exit 0
