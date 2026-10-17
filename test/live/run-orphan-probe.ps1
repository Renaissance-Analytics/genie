$ErrorActionPreference = 'Continue'
npm ci --no-audit --no-fund *> $env:TEMP\orphan-ci.log
if ($LASTEXITCODE -ne 0) { Get-Content $env:TEMP\orphan-ci.log -Tail 20; exit 1 }
npx tsx test/live/orphan-tree.live.ts
exit $LASTEXITCODE
