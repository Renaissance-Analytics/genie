# Snapshots of main for the RED PROBE in the VM (the shipped tree has no .git). Delete on merge.

    cp scripts/red-probe/route.main.ts src/core/route.ts; rm src/core/observed.ts src/main/take-over-host.ts
    npx vitest run test/observed.test.ts test/take-over-host.test.ts test/route-takeover.test.ts   # must be RED
