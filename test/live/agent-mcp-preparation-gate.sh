#!/usr/bin/env bash
set -euo pipefail
npm ci --no-audit --no-fund
npx vitest run test/agent-mcp-preparation.test.ts test/session.test.ts test/agent-session-mcp.test.ts test/chat-undelivered.test.ts test/delivery.test.ts
npm run typecheck
mkdir -p .patch
python3 - <<'PY'
from pathlib import Path
p = Path('src/core/session.ts')
s = p.read_text(encoding='utf-8')
before = 'if (this.#driver.startTracked) this.#driver.startTracked(aroundSpawn);'
after = 'if (false) this.#driver.startTracked!(aroundSpawn);'
assert s.count(before) == 1
p.write_text(s.replace(before, after), encoding='utf-8', newline='\n')
PY
restore_tracking() {
    python3 - <<'PY'
from pathlib import Path
p = Path('src/core/session.ts')
s = p.read_text(encoding='utf-8')
before = 'if (this.#driver.startTracked) this.#driver.startTracked(aroundSpawn);'
after = 'if (false) this.#driver.startTracked!(aroundSpawn);'
if after in s:
    assert s.count(after) == 1
    p.write_text(s.replace(after, before), encoding='utf-8', newline='\n')
else:
    assert s.count(before) == 1
PY
}
trap restore_tracking EXIT
if npx tsx test/live/agent-mcp-preparation.live.ts > .patch/preparation-bypass.log 2>&1; then
    cat .patch/preparation-bypass.log
    printf '%s\n' 'FAIL: bypassing delayed-spawn tracking did not fail the native ownership assertion' >&2
    exit 1
fi
if ! rg -q 'actual delayed provider descends from a recorded spawn' .patch/preparation-bypass.log; then
    cat .patch/preparation-bypass.log
    exit 1
fi
printf '%s\n' 'RED: bypassing delayed-spawn tracking fails the native ownership assertion.'
restore_tracking
npx tsx test/live/agent-mcp-preparation.live.ts
npm run verify
