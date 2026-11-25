#!/usr/bin/env bash
# vm-logon-linux.sh - LOGON START ON LINUX, PROVEN (the host split P6-3; Tynn #1036, task #1501). The Linux side of
# scripts/logon-entry-cdp.mjs. Genie's Linux entry is the freedesktop autostart file ~/.config/autostart/genie.desktop
# (core/tray-resident.ts loginItemPlan; Genie 1 wrote the same file), not a systemd --user unit: on a systemd session
# (Omarchy's uwsm) systemd's own xdg-autostart generator turns it into app-genie@autostart.service at the session start.
#
#   bash scripts/vm-logon-linux.sh table     the gate row `logon` (linux.sh): the packaged AppImage (the package row's,
#                                            or packaged here), the file read back, the setting switched live, the four cases
#   bash scripts/vm-logon-linux.sh real      a REAL logon, twice (a focused job, scripts/azure-jobs/logon-real-linux.sh):
#        the AppImage installed at ~/Applications/Genie.AppImage; the setting off + Shut down everything, then the session
#        ended and started again (SDDM restarted: its autologin logs genie in to a NEW Hyprland session) -> Genie stays
#        down; the setting on (start minimised) + Shut down everything, the same new logon -> Genie is back, genie-host up,
#        no window shown.
#
# Break probes for the real logon (logon-break.txt or LOGON_BREAK): no-entry deletes the autostart file before the second
# logon (it must fail on "Genie started at logon"); stale-entry writes one by hand before the first (it must fail on "Genie
# stayed down"). Prints `### logon-real=PASS|FAIL <why>`; the table prints the driver's `### logon-table=...`.
set -uo pipefail
MODE="${1:-table}"
ROOT="$(pwd)"
export GENIE_TEST_MACHINE=1
BREAK="${LOGON_BREAK:-}"
[ -z "$BREAK" ] && [ -f logon-break.txt ] && BREAK="$(tr -d '[:space:]' <logon-break.txt)"
[ -n "$BREAK" ] && echo "BREAK PROBE asked: $BREAK"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/genie.desktop"
INSTALLED="$HOME/Applications/Genie.AppImage"
fail() { echo "### logon-$MODE=FAIL $*"; exit 1; }

# The session's own display variables, as scripts/ci/linux.sh takes them: a shell that came in over ssh is not in it.
take_session() {
    local env_now line name
    env_now="$(systemctl --user show-environment 2>/dev/null || true)"
    for name in XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE; do
        line="$(grep -m1 "^$name=" <<<"$env_now" || true)"
        [ -n "$line" ] && export "$name=${line#*=}"
    done
}
take_session
[ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/$WAYLAND_DISPLAY" ] || fail "no Hyprland session: WAYLAND_DISPLAY='${WAYLAND_DISPLAY:-}'"
# An AppImage mounts itself with FUSE; electron-builder's AppImage runtime loads libfuse.so.2 (as vm-host-update-linux.sh).
if { ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; } || ! ldconfig -p 2>/dev/null | grep -q 'libfuse[.]so[.]2'; then
    echo "no fusermount or no libfuse.so.2: installing fuse2"
    sudo -n pacman -Sy --needed --noconfirm fuse2 >logon-fuse.log 2>&1 || { tail -20 logon-fuse.log; fail 'FUSE 2 could not be installed: the AppImage cannot run as a person runs it'; }
fi

packaged() {
    local img
    img="$(ls release/*.AppImage 2>/dev/null | head -1)"
    if [ -z "$img" ]; then
        echo '--- nothing packaged yet: the AppImage packaged here' >&2
        [ -d dist/main ] || npm run build >logon-build.log 2>&1 || { tail -30 logon-build.log >&2; return 1; }
        { npx tsx scripts/fetch-caddy.ts && npx electron-builder --linux AppImage --publish never; } >logon-package.log 2>&1 || { tail -30 logon-package.log >&2; return 1; }
        img="$(ls release/*.AppImage 2>/dev/null | head -1)"
    fi
    [ -n "$img" ] && echo "$ROOT/$img"
}

if [ "$MODE" = table ]; then
    img="$(packaged)" || fail 'the app could not be packaged'
    [ -n "$img" ] || fail 'no AppImage in release/'
    chmod +x "$img"
    LOGON_APP="$img" LOGON_APPIMAGE="$img" node scripts/logon-entry-cdp.mjs table
    exit $?
fi
[ "$MODE" = real ] || { echo "### logon=CANNOT-RUN mode '$MODE': table or real"; exit 2; }

# --- the real logon ---------------------------------------------------------------------------------------------------
hypr_pid() { pgrep -x Hyprland | head -1; }
# A NEW SESSION: SDDM restarted, so every process of the old graphical session ends, and its autologin logs genie in again;
# a new Hyprland (another pid) with its Wayland socket, and the session's environment taken again. uwsm's session start runs
# systemd's xdg-desktop-autostart.target, which is what starts an autostart entry at a logon.
new_session() {
    local before="$1" now=''
    echo "--- the session ends and genie logs in again (sudo systemctl restart sddm; Hyprland was pid ${before:-none})"
    sudo -n systemctl restart sddm || fail 'sddm could not be restarted (sudo -n)'
    for _ in $(seq 1 90); do
        sleep 2
        now="$(hypr_pid)"
        [ -n "$now" ] && [ "$now" != "$before" ] && break
        now=''
    done
    [ -n "$now" ] || fail "no new Hyprland session within 180 s of restarting sddm (was ${before:-none})"
    for _ in $(seq 1 30); do take_session; [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break; sleep 2; done
    echo "--- a new session: Hyprland pid $now, WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} ($(loginctl list-sessions --no-legend 2>/dev/null | tr '\n' ';'))"
    systemctl --user list-units --all --no-legend 'app-*@autostart.service' 2>/dev/null | sed 's/^/    autostart unit: /'
}

img="$(packaged)" || fail 'the app could not be packaged'
mkdir -p "$(dirname "$INSTALLED")"
cp -f "$img" "$INSTALLED" && chmod +x "$INSTALLED" || fail "could not install $INSTALLED"
echo "installed: $INSTALLED"
export LOGON_APP="$INSTALLED" LOGON_APPIMAGE="$INSTALLED" LOGON_OUT="$ROOT/ci-out/logon-real"
failed=''

echo; echo '=== 1. the setting off, Shut down everything, a new logon: Genie stays down ==='
node scripts/logon-entry-cdp.mjs arm off || failed+=' arm-off'
case "$BREAK" in
    stale-entry) printf '[Desktop Entry]\nType=Application\nName=Genie\nExec="%s" --hidden\nHidden=false\n' "$INSTALLED" >"$AUTOSTART"; echo "BREAK PROBE stale-entry: $AUTOSTART written by hand with the setting off" ;;
esac
new_session "$(hypr_pid)"
node scripts/logon-entry-cdp.mjs after-logon none || failed+=' stays-down'
# Whatever came up goes, and the probe's file with it.
pkill -9 -f "$INSTALLED" 2>/dev/null; pkill -9 -f '/tmp/[.]mount_Genie' 2>/dev/null; sleep 2
[ "$BREAK" = stale-entry ] && rm -f "$AUTOSTART"

echo; echo '=== 2. the setting on (start minimised), Shut down everything, a new logon: Genie is back, hidden ==='
node scripts/logon-entry-cdp.mjs arm on || failed+=' arm-on'
case "$BREAK" in
    no-entry) rm -f "$AUTOSTART"; echo "BREAK PROBE no-entry: $AUTOSTART deleted before the logon" ;;
esac
new_session "$(hypr_pid)"
node scripts/logon-entry-cdp.mjs after-logon start || failed+=' starts'
pkill -9 -f "$INSTALLED" 2>/dev/null; pkill -9 -f '/tmp/[.]mount_Genie' 2>/dev/null
for p in $(pgrep -f "$HOME/.genie/host/"); do kill -9 "$p" 2>/dev/null; done

[ -z "$failed" ] || fail "${failed# }"
echo '### logon-real=PASS'
