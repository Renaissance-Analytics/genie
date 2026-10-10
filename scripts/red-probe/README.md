# Snapshots of `main`, for the RED PROBE in the test VM

The test VM gets a tar of the working tree with no `.git`, so it cannot check out the old
implementation to watch a new test fail. These are copies of the files as they were on `main`
before the branch, used ONLY to prove the new tests go red against the old code:

    cp scripts/red-probe/lanes.main.ts src/core/lanes.ts   # inside the VM: old code
    npx vitest run test/lanes-range.test.ts                 # must be RED
    (vm-run.sh ships a fresh copy of the tree on every run, so nothing needs restoring)

TDD's "watch it fail" step is the only evidence a test exercises the thing it claims to. With
the suite running only in the VM, this is how that step survives the move.

Delete the snapshots when the branch merges. They are not shipped: `files:` in
`electron-builder.yml` packs only `dist/**` and `package.json`.
