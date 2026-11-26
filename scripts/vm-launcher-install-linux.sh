#!/usr/bin/env bash
# vm-launcher-install-linux.sh - THE LAUNCHER INSTALLS GENIE, ON LINUX (Tynn #1058 L3; the row launcher-install, linux.sh).
# In a test VM only. As a person on a fresh machine does it (the spec: "the person runs the launcher binary once"), in a
# home of its own under ci-out, inside the Hyprland session:
#
#   1. the downloaded launcher runs `genie install --profile both --from <packages>`: the launcher, the client, the browser
#      and the host land in ~/.local/share/genie/<track>/<build>, each verified against its signed manifest, with
#      ~/.local/bin/genie and the desktop entry pointing at the launcher;
#   2. Genie is opened as its desktop entry opens it (its Exec line): the launcher starts the host from its own folder,
#      then the client window, which ADOPTS that host (never starts or replaces one); the host's supervisor is ready in
#      the host's folder; a screenshot of Genie running (grim) is the visual proof;
#   3. the client-only profile, in another home: the client and the browser, no host folder, no host;
#   4. a package with one flipped byte installs nothing (in a third home), with the launcher's words;
#   5. `genie uninstall` stops the host gracefully and removes the programs, the link and the desktop entry; the data root stays.
#
# Needs the package-tracks row's release/tracks/packages and its throwaway key. Prints `### launcher-install=PASS|FAIL <why>`.
set -uo pipefail
ROOT="$(pwd)"
OUT="$ROOT/ci-out/launcher-install"
PKG="$ROOT/release/tracks/packages"
KEY="$ROOT/ci-out/setup/THROWAWAY-manifest-public-key.txt"
fail() { echo "### launcher-install=FAIL $*"; cleanup; exit 1; }
pids_started=()
cleanup() {
    local p
    for p in "${pids_started[@]}"; do kill -9 "$p" 2>/dev/null || true; done
    pkill -9 -f "$OUT/" 2>/dev/null || true
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
[ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/$WAYLAND_DISPLAY" ] || fail "no Hyprland session: WAYLAND_DISPLAY='${WAYLAND_DISPLAY:-}'"
ls "$PKG"/*.manifest.json.sig >/dev/null 2>&1 || fail "no signed packages in $PKG: see the package-tracks row"
[ -s "$KEY" ] || fail "no throwaway key at $KEY: see the package-tracks row"
BUILD="$(cat "$ROOT/release/tracks/build.txt")"
DOWNLOADED="$ROOT/release/tracks/trees/launcher/genie"
[ -x "$DOWNLOADED" ] || fail "no launcher at $DOWNLOADED"

rm -rf "$OUT"; mkdir -p "$OUT"
fresh_home() { local h="$OUT/$1"; mkdir -p "$h/Downloads"; chmod 700 "$h"; cp "$DOWNLOADED" "$h/Downloads/genie"; chmod 755 "$h/Downloads/genie"; echo "$h"; }
as_person() { local h="$1"; shift; env -u XDG_DATA_HOME -u XDG_CONFIG_HOME -u GENIE_HOME -u GENIE_CODE_ROOT HOME="$h" "$@"; }

# --- 1. install ---------------------------------------------------------------------------------------------------------
H="$(fresh_home both)"
echo "--- 1. the downloaded launcher installs Genie ($BUILD) into $H"
as_person "$H" "$H/Downloads/genie" install --profile both --from "$PKG" --yes >"$OUT/install.log" 2>&1 || { cat "$OUT/install.log"; fail "genie install --profile both refused"; }
cat "$OUT/install.log"
CODE="$H/.local/share/genie"
for t in launcher client browser host; do
    [ -f "$CODE/$t/$BUILD/.complete" ] && [ -f "$CODE/$t/$BUILD/manifest.json.sig" ] || fail "$t $BUILD is not complete in $CODE/$t"
done
[ "$(readlink "$H/.local/bin/genie")" = "$CODE/launcher/$BUILD/genie" ] || fail "~/.local/bin/genie does not point at the installed launcher ($(readlink "$H/.local/bin/genie"))"
ENTRY="$H/.local/share/applications/genie.desktop"
[ -f "$ENTRY" ] || fail "no desktop entry"
sed 's/^/    /' "$ENTRY"
EXEC="$(grep -m1 '^Exec=' "$ENTRY" | sed 's/^Exec=//; s/ %u$//')"
[ "$EXEC" = "$H/.local/bin/genie" ] || fail "the desktop entry runs '$EXEC', not the launcher"
as_person "$H" "$EXEC" status --json >"$OUT/status-installed.json" || fail "genie status failed"
cat "$OUT/status-installed.json"; echo
grep -q '"profile":"both"' "$OUT/status-installed.json" || fail 'the profile is not both'
for t in client browser host; do
    node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(s.tracks[process.argv[2]]&&s.tracks[process.argv[2]].verified===true?0:1)' "$OUT/status-installed.json" "$t" || fail "$t does not verify after the install"
done

# --- 2. open Genie as the desktop entry does -------------------------------------------------------------------------
echo "--- 2. Genie opened from its desktop entry ($EXEC)"
as_person "$H" setsid "$EXEC" >"$OUT/launcher.log" 2>&1 </dev/null &
pids_started+=($!)
LIFE="$H/.genie/runtime/lifecycle.log"
linked=''
for _ in $(seq 1 120); do
    linked="$(grep -m1 -E 'agent host (adopted|started|replaced) pid=' "$LIFE" 2>/dev/null || true)"
    [ -n "$linked" ] && break
    sleep 1
done
[ -n "$linked" ] || { tail -40 "$OUT/launcher.log"; tail -40 "$H/.genie/logs/genie-host.log" 2>/dev/null; tail -40 "$H/.genie/logs/genie-client.log" 2>/dev/null; tail -30 "$LIFE" 2>/dev/null; fail 'the client window never linked to a host within 120 s'; }
echo "the client: $linked"
[[ "$linked" == *"agent host adopted pid="* ]] || fail "the client did not ADOPT the launcher's host: $linked"
as_person "$H" "$EXEC" status --json >"$OUT/status-running.json"
cat "$OUT/status-running.json"; echo
HOST_PID="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(s.host.running?s.host.pid:"")' "$OUT/status-running.json")"
[ -n "$HOST_PID" ] || fail 'the launcher says no host is running'
HOST_EXE="$(readlink "/proc/$HOST_PID/exe")"
[ "$HOST_EXE" = "$CODE/host/$BUILD/genie-host" ] || fail "genie-host runs from '$HOST_EXE', not its own folder $CODE/host/$BUILD"
echo "genie-host pid $HOST_PID runs from $HOST_EXE"
CLIENT_EXE=''
for p in $(pgrep -f "$CODE/client/$BUILD/genie-client" || true); do CLIENT_EXE="$(readlink "/proc/$p/exe" 2>/dev/null)"; [ -n "$CLIENT_EXE" ] && break; done
[ "$CLIENT_EXE" = "$CODE/client/$BUILD/genie-client" ] || fail "no genie-client runs from $CODE/client/$BUILD (found '$CLIENT_EXE')"
echo "the client runs from $CLIENT_EXE"
ready=''
for _ in $(seq 1 60); do ready="$(grep -m1 'containment ready supervisor=' "$LIFE" 2>/dev/null || true)"; [ -n "$ready" ] && break; sleep 1; done
[ -n "$ready" ] || fail "genie-host did not say its supervisor is ready within 60 s"
[[ "$ready" == *"$CODE/host/$BUILD/"* ]] || fail "genie-host's supervisor is not in the host's own folder: $ready"
echo "genie-host: $ready"
grep -q 'started by the launcher' "$LIFE" || fail 'the client did not say the launcher started it'
# Nothing of the single-app install: no copy under ~/.genie/host (the launcher's host IS P6-1's copy, made at build time).
[ ! -d "$H/.genie/host" ] || fail "a host copy was made under ~/.genie/host: $(ls "$H/.genie/host")"
# THE VISUAL PROOF: Genie's window, as the person sees it, after a launcher install.
sleep 12
if command -v grim >/dev/null 2>&1; then
    grim "$OUT/genie-running-linux.png" && echo "SCREENSHOT $OUT/genie-running-linux.png" || fail 'grim could not take the screenshot'
else
    fail 'grim is not on this machine: no visual proof'
fi

# --- 3. client only, in another home ---------------------------------------------------------------------------------
C="$(fresh_home client)"
echo "--- 3. the client-only profile ($C)"
as_person "$C" "$C/Downloads/genie" install --profile client --from "$PKG" --yes >"$OUT/install-client.log" 2>&1 || { cat "$OUT/install-client.log"; fail 'genie install --profile client refused'; }
cat "$OUT/install-client.log"
[ -f "$C/.local/share/genie/client/$BUILD/.complete" ] && [ -f "$C/.local/share/genie/browser/$BUILD/.complete" ] || fail 'the client-only install has no client or browser'
[ ! -e "$C/.local/share/genie/host" ] || fail 'the client-only install has a host folder'
as_person "$C" "$C/.local/bin/genie" status --json | tee "$OUT/status-client.json" | grep -q '"profile":"client"' || fail 'the profile is not client'
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(s.tracks.host?1:0)' "$OUT/status-client.json" || fail 'the client-only state points at a host'
echo

# --- 4. a flipped byte installs nothing -------------------------------------------------------------------------------
T="$(fresh_home tampered)"
echo "--- 4. one flipped byte in the host's package"
mkdir -p "$OUT/tampered-packages"; cp "$PKG"/* "$OUT/tampered-packages/"
# The host's tree again with one byte of its entry flipped, packed as the release packs it, beside the ORIGINAL signed
# manifest: the archive is not the one the signature covers.
rm -rf "$OUT/tampered-tree"; cp -r "$ROOT/release/tracks/trees/host" "$OUT/tampered-tree"
node -e 'const f=require("fs");const p=process.argv[1];const b=f.readFileSync(p);b[10]^=1;f.writeFileSync(p,b)' "$OUT/tampered-tree/app/dist/main/host.js"
node --input-type=module -e "import { packTrack } from '$ROOT/scripts/pack-track.mjs'; await packTrack({ track: 'host', build: '$BUILD', channel: 'dev', platform: 'linux', arch: 'x64', withClient: '$BUILD', minLauncher: null, notes: 'Genie $BUILD', from: '$OUT/tampered-tree', out: '$OUT/tampered-out' });" || fail 'the tampered host could not be packed'
cp "$OUT"/tampered-out/host-*.tar.zst "$OUT/tampered-packages/"
cmp -s "$OUT"/tampered-out/host-*.manifest.json "$OUT"/tampered-packages/host-*.manifest.json && fail 'CONTROL: the flipped byte did not change the host package'
if as_person "$T" "$T/Downloads/genie" install --profile both --from "$OUT/tampered-packages" --yes >"$OUT/install-tampered.log" 2>&1; then
    cat "$OUT/install-tampered.log"; fail 'a package with a flipped byte installed'
fi
cat "$OUT/install-tampered.log"
grep -q 'do not match its signed manifest' "$OUT/install-tampered.log" || fail 'the refusal does not say why in words'
left="$(find "$T/.local/share/genie" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | grep -v '/launcher/' || true)"
[ -z "$left" ] || fail "a refused install left builds: $left"

# --- 5. uninstall ------------------------------------------------------------------------------------------------------
echo "--- 5. genie uninstall"
pkill -f "$CODE/client/" 2>/dev/null || true
as_person "$H" "$EXEC" uninstall >"$OUT/uninstall.log" 2>&1 || { cat "$OUT/uninstall.log"; fail 'genie uninstall failed'; }
cat "$OUT/uninstall.log"
for _ in $(seq 1 30); do kill -0 "$HOST_PID" 2>/dev/null || break; sleep 1; done
kill -0 "$HOST_PID" 2>/dev/null && fail "genie-host (pid $HOST_PID) still runs after the uninstall"
grep -q 'genie-host' "$H/.genie/logs/genie-host.log" 2>/dev/null || true
[ ! -e "$CODE" ] || fail 'the programs folder is still there'
[ ! -e "$H/.local/bin/genie" ] && [ ! -e "$ENTRY" ] || fail 'the link or the desktop entry is still there'
[ -d "$H/.genie" ] || fail 'the data root was removed'
cleanup
echo "### launcher-install=PASS the launcher installed the client, browser and host ($BUILD) verified, started the host from its own folder, the client window adopted it, client-only and a tampered package behaved, and uninstall stopped the host and removed the programs"
