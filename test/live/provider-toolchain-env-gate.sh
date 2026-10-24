#!/usr/bin/env bash
set -euo pipefail
npm ci --no-audit --no-fund
npx vitest run test/provider-npm-prefix.test.ts test/provider-launch-script.test.ts test/agent-service-env.test.ts test/provider-models.test.ts
npm run typecheck
mkdir -p .patch
cp src/main/session-host.ts .patch/provider-env.original.ts
restore_env() { cp .patch/provider-env.original.ts src/main/session-host.ts; }
trap restore_env EXIT
python3 - <<'PY'
from pathlib import Path
p=Path('src/main/session-host.ts'); s=p.read_text(encoding='utf-8')
line='for (const name of Object.keys(parentEnv)) if (name.toUpperCase() === key) delete parentEnv[name];'
assert s.count(line)==1
p.write_text(s.replace(line,'// Deliberate test bypass: retain competing case variants.'),encoding='utf-8',newline='\n')
PY
if npx tsx test/live/provider-toolchain-env.live.ts > .patch/provider-env-bypass.log 2>&1; then
    cat .patch/provider-env-bypass.log
    echo 'FAIL: npm case-canonicalization bypass did not fail' >&2; exit 1
fi
if ! rg -q 'SDK child uses the host npm prefix' .patch/provider-env-bypass.log; then cat .patch/provider-env-bypass.log; exit 1; fi
echo 'RED: retaining inherited lowercase npm_config_prefix fails the native npm prefix assertion.'
restore_env
npx tsx test/live/provider-toolchain-env.live.ts
npm run verify
