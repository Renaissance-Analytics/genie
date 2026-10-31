#!/usr/bin/env bash
# THE PHONE'S LIVE PROOF (genie#1346) — run INSIDE omarchy-test through the envelope's vm-fifo.sh, never on a desktop:
#   OMARCHY_FETCH='mobile-evidence=<local dir>' scripts/vm-fifo.sh omarchy <tree> 'bash scripts/mobile-proof/run.sh'
#   MOBILE_PROOF=confirm … — the pairing confirm and the expiry mark instead (drive-confirm.mjs, genie#1366): a device
#   last seen 80 days ago is seeded before Genie starts, so its pairing is 10 days from the end of its 90.
#
# 1. Build Genie. 2. Give the VM a tailnet address: a CGNAT IPv4 on its loopback, and a `tailscale` on PATH whose
# `status --json` reports it (what Genie's listener reads — nothing in src/ knows this script exists). 3. Seed a workspace
# with files and two agents; point claude at the chat stub. 4. Launch Genie with CDP. 5. Drive the phone (drive.mjs).
# 6. Record what the listener is bound to, and that an unpaired socket gets nothing.
set -uo pipefail
TREE="$(pwd)"
EVIDENCE="$TREE/mobile-evidence"
mkdir -p "$EVIDENCE"
exec > >(tee "$EVIDENCE/run.log") 2>&1
IP=100.100.7.7

if [ "${MOBILE_PROOF:-}" = confirm ]; then
    # The confirm proof screenshots GENIE'S OWN WINDOW (the phone proof only screenshots headless Chromium). Omarchy locks
    # an idle session after 300 s (~/.config/omarchy/shell.json: screensaver 150, lock 300) — before the build is even
    # done — and a window under the lock screen paints no frames, so CDP's Page.captureScreenshot waits forever (measured
    # 2026-10-31: the run hung there, dpmsStatus 0, then "Enter Password" on the console). Stay awake, the omarchy way.
    OTI="$(command -v omarchy-toggle-idle || echo /usr/share/omarchy/bin/omarchy-toggle-idle)"
    "$OTI" stay-awake && echo "=== idle lock off: $("$OTI" --status)"
fi

echo "=== npm ci + build"
npm ci --no-audit --no-fund >/tmp/npmci.log 2>&1 || { tail -30 /tmp/npmci.log; exit 1; }
npm run build >/tmp/build.log 2>&1 || { tail -40 /tmp/build.log; exit 1; }
npm i --no-save --no-audit --no-fund playwright-core@1 >/tmp/pw.log 2>&1 || { tail -20 /tmp/pw.log; exit 1; }
CHROMIUM="$(command -v chromium || command -v chromium-browser || true)"
[ -n "$CHROMIUM" ] || { echo "no chromium in the VM"; exit 1; }
export CHROMIUM

echo "=== a tailnet address for this VM: $IP on lo, and tailscale status reporting it"
sudo ip addr add "$IP/32" dev lo
mkdir -p "$HOME/fakebin"
cat > "$HOME/fakebin/tailscale" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = status ]; then
  echo '{"BackendState":"Running","Self":{"DNSName":"omarchy-test.tailnet-proof.ts.net.","TailscaleIPs":["$IP","fd7a:115c:a1e0::7"]}}'
  exit 0
fi
# tailscale cert --cert-file F --key-file K <name>: a real Tailscale cert is Let's Encrypt's; this one is self-signed for the
# same name, and the phone's browser is told to trust its key (drive.mjs). Genie's code path is the same.
if [ "\${1:-}" = cert ]; then
  certf="\$3"; keyf="\$5"; name="\$6"
  # Like the real one, it hands back the SAME cert until renewal is due: issued once, cached, copied out on every call.
  cache="\$HOME/fakebin/cert-cache"
  if [ ! -f "\$cache/cert.pem" ]; then
    mkdir -p "\$cache"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "\$cache/key.pem" -out "\$cache/cert.pem" -days 30 -subj "/CN=\$name" -addext "subjectAltName=DNS:\$name" 2>/dev/null || exit 1
  fi
  cp "\$cache/cert.pem" "\$certf" && cp "\$cache/key.pem" "\$keyf"
  exit \$?
fi
echo "fake tailscale: \$*" >&2; exit 1
EOF
chmod +x "$HOME/fakebin/tailscale"
export PATH="$HOME/fakebin:$PATH"

echo "=== seed a workspace with files, and its agents"
WS="$HOME/mobile-ws"
mkdir -p "$WS/docs" "$WS/src" "$WS/images"
printf '# Mobile proof\n\nThis workspace is **seeded** for the phone proof.\n\n- one\n- two\n' > "$WS/README.md"
printf 'Notes for the docs folder.\n' > "$WS/docs/notes.md"
printf 'export function hello(name: string): string {\n    return `hello ${name}`;\n}\n' > "$WS/src/app.ts"
node -e "
const fs=require('fs');
// A tiny valid PDF.
const pdf='%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
fs.writeFileSync('$WS/spec.pdf', pdf);
"
( cd "$WS" && node "$TREE/scripts/smoke-seed.mjs" )

if [ "${MOBILE_PROOF:-}" = confirm ]; then
    echo "=== seed a paired device last seen 80 days ago (10 of its 90 days left): the time near expiry, simulated"
    export OLD_DEVICE_TOKEN=proof-old-device-token OLD_DEVICE_LABEL='Pixel 6 (old)'
    mkdir -p "$HOME/.genie/runtime"
    node -e "
const { createHash } = require('crypto');
const day = 86400000, now = Date.now();
const h = createHash('sha256').update(process.env.OLD_DEVICE_TOKEN).digest('hex');
const at = (d) => new Date(now - d * day).toISOString();
require('fs').writeFileSync(process.env.HOME + '/.genie/runtime/remote-devices.json', JSON.stringify({ devices: [{ id: 'dev_' + h.slice(0, 12), label: process.env.OLD_DEVICE_LABEL, pairedAt: at(200), lastSeenAt: at(80), tokenHash: h }] }, null, 2));
"
fi

echo "=== launch Genie (claude → the chat stub, codex → the codex stub)"
export GENIE2_CLAUDE_BINARY="$TREE/scripts/mobile-proof/stub-claude-chat.mjs"
export GENIE2_CODEX_BINARY="$TREE/scripts/stub-codex.mjs"
chmod +x "$GENIE2_CLAUDE_BINARY" "$GENIE2_CODEX_BINARY"
rm -rf /tmp/genie-stub-claude-received
if [ "${MOBILE_PROOF:-}" = confirm ]; then
    # The confirm proof needs Genie's window ON SCREEN (its screenshots and hovers). A Wayland-native Electron window never
    # appears in this VM's Hyprland — `hyprctl clients` says "no open windows" while the page reports itself visible — and
    # main does the same (control run 2026-10-31, genie#1366), so it is this VM, not the change. Xwayland maps it.
    DISPLAY="${DISPLAY:-:0}" npx electron . --no-sandbox --ozone-platform=x11 --remote-debugging-port=9222 >/tmp/electron.log 2>&1 &
else
    npx electron . --no-sandbox --ozone-platform=wayland --enable-features=UseOzonePlatform --remote-debugging-port=9222 >/tmp/electron.log 2>&1 &
fi
GENIE_PID=$!

echo "=== drive the phone"
if [ "${MOBILE_PROOF:-}" = confirm ]; then
    # What the compositor shows (the desktop screenshots are taken from it, with grim): Genie's window must be mapped.
    export HYPRLAND_INSTANCE_SIGNATURE="${HYPRLAND_INSTANCE_SIGNATURE:-$(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | head -1)}"
    sleep 8
    # Omarchy's first-login notifications sit over the top of the screen (run 5's shots): out of the way, the omarchy way.
    for n in "Update System" "Learn Keybindings"; do /usr/share/omarchy/bin/omarchy-notification-dismiss "$n" >/dev/null 2>&1 || true; done
    { hyprctl monitors; hyprctl clients; } > "$EVIDENCE/hypr-state.txt" 2>&1 || true
    grep -E "^Window|class:|title:|mapped:|hidden:|workspace:|dpmsStatus" "$EVIDENCE/hypr-state.txt" | head -20
    # The renewal step dials the socket from node; the VM's fake `tailscale cert` is self-signed.
    NODE_TLS_REJECT_UNAUTHORIZED=0 TAILNET_IP="$IP" node scripts/mobile-proof/drive-confirm.mjs
else
    MOBILE_WS="$WS" TAILNET_IP="$IP" node scripts/mobile-proof/drive.mjs
fi
DRIVE=$?

echo "=== what the remote socket is bound to (ss -ltn)"
ss -ltn | grep -E ':7421\b' | tee "$EVIDENCE/bind.txt" || echo "nothing on 7421 (remote access is off after the device was removed? it stays on)" | tee "$EVIDENCE/bind.txt"

echo "=== an unpaired socket: a made-up token is refused and closed; a call before hello is refused"
NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "
const ws = new WebSocket('wss://$IP:7421/genie');
const got = [];
ws.onopen = () => { ws.send(JSON.stringify({kind:'call',id:1,method:'snapshot',args:[]})); ws.send(JSON.stringify({kind:'hello',auth:{kind:'token',token:'not-a-real-token'},label:'intruder'})); };
ws.onmessage = (e) => got.push(String(e.data));
ws.onclose = () => { console.log(JSON.stringify(got)); process.exit(0); };
setTimeout(() => { console.log('still open after 5s: ' + JSON.stringify(got)); process.exit(1); }, 5000);
" 2>&1 | tee "$EVIDENCE/unpaired.txt"
echo "=== nothing answers on the VM's other addresses"
for a in 127.0.0.1 $(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1); do
    if curl -sk -o /dev/null -m 3 "https://$a:7421/mobile" || curl -s -o /dev/null -m 3 "http://$a:7421/mobile"; then echo "$a:7421 ANSWERED"; else echo "$a:7421 refused"; fi
done | tee "$EVIDENCE/other-addresses.txt"

cp /tmp/electron.log "$EVIDENCE/electron.log" 2>/dev/null || true
ls -la /tmp/genie-stub-claude-received > "$EVIDENCE/agent-received.txt" 2>&1 || true
kill "$GENIE_PID" 2>/dev/null || true
exit "$DRIVE"
