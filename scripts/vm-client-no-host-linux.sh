#!/usr/bin/env bash
# vm-client-no-host-linux.sh - A CLIENT WITH NO HOST, ON LINUX (Tynn #1058 L4; the row client-no-host, linux.sh). In a test
# VM only, inside the Hyprland session. Two installs on one machine, each in a home of its own under ci-out, from the
# package-tracks row's signed packages (scripts/vm-client-no-host.ps1 is the same proof on Windows):
#
#   A, the `client` profile: opened by its launcher (`genie`), the client starts NO process and shows the host directory,
#      empty; photographed at 1280x800 through its debugger (host-directory-empty-linux.png); then its paired hosts, seeded
#      as device-hosts.json holds them, addresses only (host-directory-paired-linux.png).
#   B, the `both` profile: its launcher starts its host, which A's client never touches (the same pid and start time).
#   B with its host stopped (`genie stop-host`): its client shows it stopped with Start (host-directory-stopped-linux.png);
#      Start asks B's launcher, which starts the host, and the client links to it.
#
# The client is started as the launcher starts it (control.rs start_component: its program, GENIE_HOME, GENIE_LAUNCHER_EXE,
# GENIE_LAUNCHER_HOST_BUILD when there is a host) plus --remote-debugging-port for the pictures.
# Not here (step 4 of the split): a window on a paired host from a client-only machine, and Tynn's list of hosts.
# Prints `### client-no-host=PASS|FAIL <why>`.
set -uo pipefail
ROOT="$(pwd)"
OUT="$ROOT/ci-out/client-no-host"
PKG="$ROOT/release/tracks/packages"
DOWNLOADED="$ROOT/release/tracks/trees/launcher/genie"
# Debugger ports of this row's own (test/ci-debug-ports-unique.test.ts): A's client, then B's.
PORT_A=9461
PORT_B=9462
pids_started=()
cleanup() { local p; for p in "${pids_started[@]}"; do kill -9 "$p" 2>/dev/null || true; done; pkill -9 -f "$OUT/" 2>/dev/null || true; }
fail() {
    local h f
    for h in "$OUT/a" "$OUT/b"; do for f in .genie/runtime/lifecycle.log .genie/logs/genie-host.log .genie/logs/genie-client.log; do [ -f "$h/$f" ] && { echo "--- $h/$f"; tail -25 "$h/$f"; }; done; done
    echo "### client-no-host=FAIL $*"; cleanup; exit 1
}
take_session() {
    local env_now line name
    env_now="$(systemctl --user show-environment 2>/dev/null || true)"
    for name in XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE DBUS_SESSION_BUS_ADDRESS; do
        line="$(grep -m1 "^$name=" <<<"$env_now" || true)"
        [ -n "$line" ] && export "$name=${line#*=}"
    done
}
take_session
[ -n "${WAYLAND_DISPLAY:-}" ] || fail "no Hyprland session"
[ -f "$ROOT/release/tracks/build.txt" ] || fail 'no release/tracks/build.txt: see the package-tracks row'
BUILD="$(cat "$ROOT/release/tracks/build.txt")"
[ -x "$DOWNLOADED" ] || fail "no launcher at $DOWNLOADED"
rm -rf "$OUT"; mkdir -p "$OUT"
as_person() { local h="$1"; shift; env -u XDG_DATA_HOME -u XDG_CONFIG_HOME -u GENIE_HOME -u GENIE_CODE_ROOT -u GENIE_LAUNCHER_EXE -u GENIE_LAUNCHER_HOST_BUILD HOME="$h" "$@"; }
home() { local h="$OUT/$1"; mkdir -p "$h"; chmod 700 "$h"; echo "$h"; }
wait_line() { local file="$1" pat="$2" secs="$3" i; for i in $(seq 1 "$secs"); do grep -m1 -E "$pat" "$file" 2>/dev/null && return 0; sleep 1; done; return 1; }
hosts_of() { local p; for p in $(pgrep -x genie-host || true); do [[ "$(readlink "/proc/$p/exe" 2>/dev/null)" == "$1"/* ]] && echo "$p"; done; }
clients_of() { local p; for p in $(pgrep -f "$1/client/" || true); do [[ "$(readlink "/proc/$p/exe" 2>/dev/null)" == "$1"/client/* ]] && echo "$p"; done; }
stop_clients() { local p; for p in $(clients_of "$1"); do kill "$p" 2>/dev/null || true; done; sleep 2; for p in $(clients_of "$1"); do kill -9 "$p" 2>/dev/null || true; done; }
started_at() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null; }
# The client as the launcher starts it, with its debugger for the pictures.
start_client() {
    local h="$1" hostbuild="$2" port="$3" exe="$1/.local/share/genie/client/$BUILD/genie-client"
    [ -x "$exe" ] || fail "no client at $exe"
    as_person "$h" env GENIE_HOME="$h/.genie" GENIE_LAUNCHER_EXE="$h/.local/bin/genie" ${hostbuild:+GENIE_LAUNCHER_HOST_BUILD=$hostbuild} setsid "$exe" --open-window --remote-debugging-port="$port" >"$OUT/client-$port.log" 2>&1 </dev/null &
    pids_started+=($!)
}
rows_of() { grep -m1 '^ROWS ' "$1" | cut -c6-; }

# --- 1. A, client only, opened by its launcher -----------------------------------------------------------------------
A="$(home a)"; ACODE="$A/.local/share/genie"
echo "--- 1. A: the client profile ($A), build $BUILD"
as_person "$A" "$DOWNLOADED" install --profile client --from "$PKG" --yes || fail 'A: install --profile client refused'
[ ! -e "$ACODE/host" ] || fail 'A, a client-only install, has a host folder'
hosts_before="$(pgrep -x genie-host | wc -l)"
as_person "$A" setsid "$A/.local/bin/genie" >"$OUT/a-launcher.log" 2>&1 </dev/null &
pids_started+=($!)
ALIFE="$A/.genie/runtime/lifecycle.log"
shown="$(wait_line "$ALIFE" 'host directory shown' 120)" || fail "A's client, opened by its launcher, did not show the host directory within 120 s"
echo "A: $shown"
[[ "$shown" == *"(empty)"* ]] || fail "A's directory is not empty: $shown"
grep -q 'started by the launcher' "$ALIFE" || fail "A's client was not started by its launcher"
sleep 3
[ ! -e "$A/.genie/runtime/host.json" ] || fail 'A wrote a host.json'
[ ! -e "$A/.genie/host" ] || fail 'A made a host copy'
[ -z "$(hosts_of "$ACODE")" ] && [ "$(pgrep -x genie-host | wc -l)" = "$hosts_before" ] || fail 'a genie-host started for A'
for c in $(clients_of "$ACODE"); do for k in $(pgrep -P "$c" || true); do [[ "$(readlink "/proc/$k/exe" 2>/dev/null)" == "$ACODE"/client/* ]] || fail "A's client started $(readlink "/proc/$k/exe") (pid $k)"; done; done
echo 'A: no host.json, no host copy, no genie-host, no child process but its own'
stop_clients "$ACODE"

# --- 2. B, both: its launcher starts its host -----------------------------------------------------------------------
B="$(home b)"; BCODE="$B/.local/share/genie"
echo "--- 2. B: the both profile ($B)"
as_person "$B" "$DOWNLOADED" install --profile both --from "$PKG" --yes || fail 'B: install refused'
as_person "$B" setsid "$B/.local/bin/genie" >"$OUT/b-launcher.log" 2>&1 </dev/null &
pids_started+=($!)
BLIFE="$B/.genie/runtime/lifecycle.log"
linked="$(wait_line "$BLIFE" 'agent host (adopted|started|replaced) pid=' 180)" || fail "B's client never linked to B's host"
[[ "$linked" == *"agent host adopted pid="* ]] || fail "B's client did not adopt its launcher's host: $linked"
BHOST="$(hosts_of "$BCODE" | head -1)"; [ -n "$BHOST" ] || fail "no genie-host runs from $BCODE"
BSTART="$(started_at "$BHOST")"
echo "B: genie-host pid $BHOST from $(readlink "/proc/$BHOST/exe"), start $BSTART"
stop_clients "$BCODE"

# --- 3. A's directory beside B's host ----------------------------------------------------------------------------------
echo "--- 3. A's client beside B's host"
start_client "$A" '' "$PORT_A"
node scripts/host-directory-cdp.mjs "$PORT_A" "$OUT" host-directory-empty-linux.png | tee "$OUT/empty.out" || fail 'the empty directory was not photographed (above)'
node -e 'const r=JSON.parse(process.argv[1]);process.exit(r.empty==="No host on this computer. Pick a host, or add one."&&r.add?0:1)' "$(rows_of "$OUT/empty.out")" || fail "the empty state is $(rows_of "$OUT/empty.out")"
printf '{"hosts":["wss://studio.example:7443","ws://10.0.0.5:7443"]}' >"$A/.genie/runtime/device-hosts.json"
node scripts/host-directory-cdp.mjs "$PORT_A" "$OUT" host-directory-paired-linux.png reload | tee "$OUT/paired.out" || fail 'the paired directory was not photographed (above)'
node -e 'const r=JSON.parse(process.argv[1]);process.exit(r.rows.map(x=>x.id).join(",")==="wss://studio.example:7443,ws://10.0.0.5:7443"&&r.rows.every(x=>x.state==="paired")?0:1)' "$(rows_of "$OUT/paired.out")" || fail "the paired rows are $(rows_of "$OUT/paired.out")"
[ "$(started_at "$BHOST")" = "$BSTART" ] || fail "B's host (pid $BHOST) did not stay as it was while A's client ran"
[ -z "$(hosts_of "$ACODE")" ] && [ ! -e "$A/.genie/runtime/host.json" ] || fail 'A started a host beside B'
echo "B's host untouched: pid $BHOST, start $BSTART"
stop_clients "$ACODE"

# --- 4. B with its host stopped: the directory, then Start through the launcher ---------------------------------------
echo "--- 4. B's host stopped"
as_person "$B" "$B/.local/bin/genie" stop-host || fail 'genie stop-host failed'
for _ in $(seq 1 60); do kill -0 "$BHOST" 2>/dev/null || break; sleep 1; done
kill -0 "$BHOST" 2>/dev/null && fail "B's host did not stop"
start_client "$B" "$BUILD" "$PORT_B"
node scripts/host-directory-cdp.mjs "$PORT_B" "$OUT" host-directory-stopped-linux.png start | tee "$OUT/stopped.out" || fail 'the stopped host was not photographed and started (above)'
node -e 'const r=JSON.parse(process.argv[1]);const l=r.rows.find(x=>x.id==="local");process.exit(l&&l.state==="stopped"&&l.action==="start"?0:1)' "$(rows_of "$OUT/stopped.out")" || fail "the local row is $(rows_of "$OUT/stopped.out")"
relinked=''
for _ in $(seq 1 120); do relinked="$(grep -E 'agent host adopted pid=' "$BLIFE" | sed -n 2p)"; [ -n "$relinked" ] && break; sleep 1; done
[ -n "$relinked" ] || fail "B's client did not link to the host Start started"
FRESH="$(hosts_of "$BCODE" | head -1)"
[ -n "$FRESH" ] && [ "$FRESH" != "$BHOST" ] || fail 'no new host runs from B after Start'
echo "Start: the launcher started genie-host pid $FRESH; the client: $relinked"
cleanup
echo "### client-no-host=PASS a client-only install started no process and showed the host directory (empty, then its paired hosts) beside an untouched host of another install (pid $BHOST); with that host stopped its client showed it stopped and Start had the launcher start it"
