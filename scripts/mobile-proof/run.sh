#!/usr/bin/env bash
# THE PHONE'S LIVE PROOF (genie#1346) — run INSIDE omarchy-test through the envelope's vm-fifo.sh, never on a desktop:
#   OMARCHY_FETCH='mobile-evidence=<local dir>' scripts/vm-fifo.sh omarchy <tree> 'bash scripts/mobile-proof/run.sh'
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

echo "=== launch Genie (claude → the chat stub, codex → the codex stub)"
export GENIE2_CLAUDE_BINARY="$TREE/scripts/mobile-proof/stub-claude-chat.mjs"
export GENIE2_CODEX_BINARY="$TREE/scripts/stub-codex.mjs"
chmod +x "$GENIE2_CLAUDE_BINARY" "$GENIE2_CODEX_BINARY"
rm -rf /tmp/genie-stub-claude-received
npx electron . --no-sandbox --ozone-platform=wayland --enable-features=UseOzonePlatform --remote-debugging-port=9222 >/tmp/electron.log 2>&1 &
GENIE_PID=$!

echo "=== drive the phone"
MOBILE_WS="$WS" TAILNET_IP="$IP" node scripts/mobile-proof/drive.mjs
DRIVE=$?

echo "=== what the remote socket is bound to (ss -ltn)"
ss -ltn | grep -E ':7421\b' | tee "$EVIDENCE/bind.txt" || echo "nothing on 7421 (remote access is off after the device was removed? it stays on)" | tee "$EVIDENCE/bind.txt"

echo "=== an unpaired socket: a made-up token is refused and closed; a call before hello is refused"
node -e "
const ws = new WebSocket('ws://$IP:7421/genie');
const got = [];
ws.onopen = () => { ws.send(JSON.stringify({kind:'call',id:1,method:'snapshot',args:[]})); ws.send(JSON.stringify({kind:'hello',auth:{kind:'token',token:'not-a-real-token'},label:'intruder'})); };
ws.onmessage = (e) => got.push(String(e.data));
ws.onclose = () => { console.log(JSON.stringify(got)); process.exit(0); };
setTimeout(() => { console.log('still open after 5s: ' + JSON.stringify(got)); process.exit(1); }, 5000);
" | tee "$EVIDENCE/unpaired.txt"
echo "=== nothing answers on the VM's other addresses"
for a in 127.0.0.1 $(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1); do
    if curl -s -o /dev/null -m 3 "http://$a:7421/mobile"; then echo "$a:7421 ANSWERED"; else echo "$a:7421 refused"; fi
done | tee "$EVIDENCE/other-addresses.txt"

cp /tmp/electron.log "$EVIDENCE/electron.log" 2>/dev/null || true
ls -la /tmp/genie-stub-claude-received > "$EVIDENCE/agent-received.txt" 2>&1 || true
kill "$GENIE_PID" 2>/dev/null || true
exit "$DRIVE"
