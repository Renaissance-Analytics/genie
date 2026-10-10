# Snapshot of main for the RED PROBE (see PR #4 for the pattern). Delete on merge.

    cp scripts/red-probe/keys.main.ts src/core/keys.ts   # inside the VM: old code
    npx vitest run test/agent-keys.test.ts test/keys.test.ts   # must be RED
