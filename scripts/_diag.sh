set -euo pipefail
exec > >(tee /out/diag.txt) 2>&1
mkdir -p /work && cd /src
tar cf - --exclude=node_modules --exclude=dist --exclude=.git . | (cd /work && tar xf -)
cd /work
echo "=== npm ci ==="
npm ci --no-audit --no-fund >/tmp/ci.log 2>&1
echo "=== build ==="
npm run build >/tmp/build.log 2>&1
node scripts/smoke-seed.mjs
export GENIE2_CODEX_BINARY="$(pwd)/scripts/stub-codex.mjs"
chmod +x scripts/stub-codex.mjs
echo "=== stub standalone ==="
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' | timeout 3 "$GENIE2_CODEX_BINARY" 2>&1 | head -3 || echo "(stub exited non-zero)"
echo "=== launch ==="
xvfb-run --auto-servernum --server-args='-screen 0 1440x900x24' \
    npx electron . --no-sandbox --remote-debugging-port=9222 >/tmp/electron.log 2>&1 &
for i in $(seq 1 90); do node -e "fetch('http://127.0.0.1:9222/json/list').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null && break; sleep 1; done
echo "=== diag ==="
node scripts/_diag-approval.mjs || echo "(diag failed)"
echo "=== electron tail ==="
grep -vE "dbus|DevTools" /tmp/electron.log | tail -10 || true
echo "=== DONE ==="
