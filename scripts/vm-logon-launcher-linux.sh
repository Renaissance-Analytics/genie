#!/usr/bin/env bash
# vm-logon-launcher-linux.sh - LOGON IS THE LAUNCHER'S, ON LINUX (Tynn #1058 L5; the rows `logon` and `logon-launcher`).
# In a test VM only. The launcher writes ~/.config/autostart/genie.desktop running itself with --logon, and its run decides
# with the logon table (native/launcher/src/logon.rs = src/core/logon.ts logonEntry, test/fixtures/logon-table.json):
#
#   left running + setting on/off  -> the host starts, no window      shut down + setting on  -> the host and a window
#   shut down + setting off        -> Genie stays down until it is opened
#
#   bash scripts/vm-logon-launcher-linux.sh table   the gate row `logon`: a home of its own; the package-tracks row's signed
#        packages installed by the launcher; for each row of the table the entry read back at the OS (written, running
#        the launcher's link with --logon, or absent) and `genie --logon` run as the entry runs it: what started, and
#        what did not
#   bash scripts/vm-logon-launcher-linux.sh real    `logon-launcher` (scripts/azure-jobs/logon-launcher-linux.sh): in the
#        REAL home, three new logons (SDDM stopped, the user manager restarted, SDDM started: its autologin logs genie
#        in to a NEW Hyprland session, as after a reboot; the Linux job runner has no reboot between stages):
#          1. the setting off, Shut down everything        -> after the logon: no launcher, no host
#          2. the setting on, Shut down everything         -> after the logon: the launcher, the host and a window
#          3. the setting off, Just close the UI (left)    -> after the logon: the launcher and the host, no window
#        each after-logon screen photographed (grim).
#
# Needs the package-tracks row's release/tracks/packages. Prints `### logon-launcher-<mode>=PASS|FAIL <why>`.
set -uo pipefail
MODE="${1:-table}"
ROOT="$(pwd)"
OUT="$ROOT/ci-out/logon-launcher-$MODE"
PKG="$ROOT/release/tracks/packages"
DOWNLOADED="$ROOT/release/tracks/trees/launcher/genie"
fail() { echo "### logon-launcher-$MODE=FAIL $*"; cleanup; exit 1; }
cleanup() {
    [ -n "${H:-}" ] && [ "$H" != / ] || return 0
    pkill -9 -f "$H/.local/share/genie/" 2>/dev/null || true
    mkdir -p "$OUT/logs"
    cp "$H"/.genie/logs/*.log "$H"/.genie/runtime/lifecycle.log "$OUT/logs/" 2>/dev/null || true
    [ "$MODE" = table ] && rm -rf "$H"
    return 0
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
mkdir -p "$OUT"
[ -x "$DOWNLOADED" ] || fail "no launcher at $DOWNLOADED: see the package-tracks row"
ls "$PKG"/*.manifest.json.sig >/dev/null 2>&1 || fail "no signed packages in $PKG: see the package-tracks row"
BUILD="$(cat "$ROOT/release/tracks/build.txt")"
as_person() { env -u XDG_DATA_HOME -u XDG_CONFIG_HOME -u GENIE_HOME -u GENIE_CODE_ROOT HOME="$H" "$@"; }

install_genie() {
    as_person "$DOWNLOADED" install --profile both --from "$PKG" --yes >"$OUT/install.log" 2>&1 || { cat "$OUT/install.log"; fail 'the launcher did not install the packages'; }
    GENIE="$H/.local/bin/genie"
    [ -x "$GENIE" ] || fail "no launcher link at $GENIE"
    AUTOSTART="$H/.config/autostart/genie.desktop"
}
host_pid() { node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.kill(r.pid,0);console.log(r.pid)}catch{}' "$H/.genie/runtime/host.json"; }
launcher_pid() { node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.kill(r.pid,0);console.log(r.pid)}catch{}' "$H/.genie/runtime/launcher.json"; }
client_pids() { pgrep -f "$H/.local/share/genie/client/$BUILD/genie-client" | tr '\n' ' '; }
stop_all() {
    local l
    l="$(launcher_pid)"
    if [ -n "$l" ]; then as_person timeout 300 "$GENIE" shut-down >>"$OUT/stop.log" 2>&1 || true; fi
    as_person timeout 200 "$GENIE" stop-host >>"$OUT/stop.log" 2>&1 || true
    pkill -9 -f "$H/.local/share/genie/client/" 2>/dev/null || true
    sleep 1
}

# --- the table ---------------------------------------------------------------------------------------------------------
if [ "$MODE" = table ]; then
    H="$(cd "$ROOT/.." && pwd)/logon-launcher-home"
    rm -rf "$H"; mkdir -p "$H"; chmod 700 "$H"
    install_genie
    failed=''
    case_row() {
        local name="$1" setting="$2" left="$3" want_entry="$4" want_host="$5" want_window="$6" lp hp cp entry
        echo; echo "=== $name: setting $setting, left running $left -> entry $want_entry, host $want_host, window $want_window ==="
        stop_all
        mkdir -p "$H/.genie/runtime"
        if [ "$left" = yes ]; then : >"$H/.genie/runtime/left-running"; else rm -f "$H/.genie/runtime/left-running"; fi
        as_person "$GENIE" logon-settings "$setting" off >"$OUT/settings-$name.log" 2>&1 || { cat "$OUT/settings-$name.log"; failed+=" $name:settings"; return; }
        cat "$OUT/settings-$name.log"
        if [ -f "$AUTOSTART" ]; then
            entry="$(grep -m1 '^Exec=' "$AUTOSTART")"
            echo "  the autostart file: $entry"
            [ "$want_entry" = yes ] || failed+=" $name:entry-there"
            [ "$entry" = "Exec=\"$GENIE\" --logon" ] || failed+=" $name:entry-runs($entry)"
        else
            echo '  no autostart file'
            [ "$want_entry" = no ] || failed+=" $name:entry-missing"
        fi
        # The run the entry makes: --logon, as systemd's autostart unit starts it.
        as_person setsid "$GENIE" --logon >"$OUT/logon-$name.log" 2>&1 </dev/null &
        local runner=$!
        sleep 20
        lp="$(launcher_pid)"; hp="$(host_pid)"; cp="$(client_pids)"
        echo "  after --logon: launcher ${lp:-none}, host ${hp:-none}, client ${cp:-none}"
        sed 's/^/    /' "$OUT/logon-$name.log" | head -5
        if [ "$want_host" = yes ]; then [ -n "$hp" ] || failed+=" $name:no-host"; else [ -z "$hp" ] || failed+=" $name:host-started"; kill -0 "$runner" 2>/dev/null && failed+=" $name:launcher-stayed"; fi
        if [ "$want_window" = yes ]; then [ -n "$cp" ] || failed+=" $name:no-window"; else [ -z "$cp" ] || failed+=" $name:window-opened"; fi
    }
    case_row left-on on yes yes yes no
    case_row left-off off yes yes yes no
    case_row down-on on no yes yes yes
    case_row down-off off no no no no
    stop_all
    cleanup
    [ -z "$failed" ] || { echo "### logon-launcher-table=FAIL${failed}"; exit 1; }
    echo "### logon-launcher-table=PASS the launcher wrote (or removed) its autostart entry and its --logon run followed the logon table's four rows"
    exit 0
fi
[ "$MODE" = real ] || { echo "### logon-launcher=CANNOT-RUN mode '$MODE': table or real"; exit 2; }

# --- the real logons -----------------------------------------------------------------------------------------------------
H="$HOME"
hypr_pid() { pgrep -x Hyprland | head -1; }
new_session() {
    local before="$1" now=''
    echo "--- a new logon (sddm stopped, user@$(id -u) restarted, sddm started; Hyprland was pid ${before:-none})"
    sudo -n systemctl stop sddm || fail 'sddm could not be stopped (sudo -n)'
    sudo -n systemctl restart "user@$(id -u).service" || fail "user@$(id -u) could not be restarted (sudo -n)"
    sudo -n systemctl start sddm || fail 'sddm could not be started (sudo -n)'
    for _ in $(seq 1 90); do sleep 2; now="$(hypr_pid)"; [ -n "$now" ] && [ "$now" != "$before" ] && break; now=''; done
    [ -n "$now" ] || fail "no new Hyprland session within 180 s (was ${before:-none})"
    for _ in $(seq 1 30); do take_session; [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break; sleep 2; done
    echo "--- a new session: Hyprland pid $now"
    systemctl --user list-units --all --no-legend 'app-*@autostart.service' 2>/dev/null | sed 's/^/    autostart unit: /'
}
after_logon() {
    local name="$1" want_launcher="$2" want_host="$3" want_window="$4" lp hp cp
    sleep 40
    lp="$(launcher_pid)"; hp="$(host_pid)"; cp="$(client_pids)"
    echo "  after the logon ($name): launcher ${lp:-none}, host ${hp:-none}, client ${cp:-none}"
    grim "$OUT/after-logon-$name-linux.png" 2>/dev/null && echo "SCREENSHOT $OUT/after-logon-$name-linux.png"
    [ "$want_launcher" = yes ] && [ -z "$lp" ] && failed+=" $name:no-launcher"
    [ "$want_launcher" = no ] && [ -n "$lp" ] && failed+=" $name:launcher-started"
    [ "$want_host" = yes ] && [ -z "$hp" ] && failed+=" $name:no-host"
    [ "$want_host" = no ] && [ -n "$hp" ] && failed+=" $name:host-started"
    [ "$want_window" = yes ] && [ -z "$cp" ] && failed+=" $name:no-window"
    [ "$want_window" = no ] && [ -n "$cp" ] && failed+=" $name:window-opened"
    return 0
}
# A running launcher of this user's, with the host: what the person had going before they left.
running_genie() {
    as_person setsid "$GENIE" serve >"$OUT/serve-$1.log" 2>&1 </dev/null &
    for _ in $(seq 1 30); do [ -n "$(launcher_pid)" ] && break; sleep 1; done
    as_person timeout 120 "$GENIE" ensure-host >>"$OUT/serve-$1.log" 2>&1 || fail "the host did not start ($1)"
}
install_genie
failed=''
echo; echo '=== 1. the setting off, Shut down everything, a new logon: Genie stays down ==='
stop_all
as_person "$GENIE" logon-settings off off
running_genie down-off
as_person timeout 300 "$GENIE" shut-down || failed+=' 1:shut-down'
[ -f "$AUTOSTART" ] && failed+=' 1:entry-left'
new_session "$(hypr_pid)"
after_logon down-off no no no
stop_all

echo; echo '=== 2. the setting on, Shut down everything, a new logon: the launcher, the host and a window ==='
as_person "$GENIE" logon-settings on off
running_genie down-on
as_person timeout 300 "$GENIE" shut-down || failed+=' 2:shut-down'
[ -f "$AUTOSTART" ] || failed+=' 2:no-entry'
sed 's/^/    /' "$AUTOSTART" 2>/dev/null
new_session "$(hypr_pid)"
after_logon down-on yes yes yes
stop_all

echo; echo '=== 3. the setting off, Just close the UI with the host running, a new logon: the launcher and the host, no window ==='
as_person "$GENIE" logon-settings off off
running_genie left
as_person timeout 60 "$GENIE" close-ui || failed+=' 3:close-ui'
[ -f "$H/.genie/runtime/left-running" ] || failed+=' 3:not-marked'
[ -f "$AUTOSTART" ] || failed+=' 3:no-entry'
new_session "$(hypr_pid)"
after_logon left yes yes no
stop_all
as_person "$GENIE" logon-settings off off >/dev/null 2>&1
rm -f "$H/.genie/runtime/left-running"
[ -z "$failed" ] || fail "${failed# }"
echo "### logon-launcher-real=PASS three new logons followed the logon table: stayed down; the launcher, the host and a window; the launcher and the host with no window"
