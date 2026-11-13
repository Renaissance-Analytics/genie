# Unit-suite disk candidates (Tynn #671)

Static inventory at `d7c0a7d2`, before changes. These are candidates, **not measured rankings**. The Windows job
`unit-disk-windows.ps1` measures them individually, then the whole suite once. Repeat the identical job after each
accepted reduction. Keep its complete output directory, including failed runs and coverage warnings.

Run on **Standard_D16ads_v5**, in genie's logged-on session with the Azure `In-Session` helper. It passes no SSH
environment or arguments: defaults are sufficient for BEFORE. AFTER overrides must be set inside a logged-on
wrapper script. The first SSH run `1113-120023-50f30b` at `ab628c45` is **unusable**: zero observed workers,
unreported discovery exceptions, null process exit codes, and identity-dependent full-suite failures under SSH.
Do not use it as a baseline or compare optimizations against it.

The existing public-SDK >512 MiB case is always the first candidate and the gauge's positive control. A successful
test run, at least one readable worker, >=512 MiB of worker transfer counts and zero discovery errors are required
before the remaining candidates/full suite run. It reuses the same candidate, writing no extra fixture. Discovery
exception stage, type, ID, line and message are retained (ten distinct messages maximum). No timestamps are used
to filter the newly launched process's ancestry; native retained-handle exit status is recorded explicitly.

| Candidate | Evidence / reason to measure |
| --- | --- |
| `test/prism-harness-0103.test.ts:43` | Streams JSONL until 540 MiB. Its public-SDK claim is the Node string-size regression above 512 MiB; keep that boundary proof. |
| `test/thread-rotation.test.ts:108` | Writes a 512 MiB old thread, then appends/indexes and measures restart, pending drafts and paging. Also has many durable seeded turns. |
| `test/bounded-ledgers.test.ts:169` | 400 old rows with 40 KiB input + output (about 32 MiB), plus boot's 300 rows with 100 KiB each way (about 60 MiB), through the durable store. Historical 600 MB is already reduced. |
| `test/ledger-1gb-probe.test.ts:66` | Its unit fixture is 240 rows / 30 tool pairs at 20–64 KiB, not the full live 1 GB fixture named in its shape assertion. Measure actual writes. |
| `test/inbox-store.test.ts:244` | Writes a buffer of 25 MiB + 1 byte for the attachment cap, alongside durable inbox cases. Boundary size may be essential. |
| `test/thread-history-bounded.test.ts:48` | Repeated turns and per-turn tool rows through the real store; inspect measured aggregate, not just largest row. |
| `test/thread-rotation-sidecars.test.ts:18` | Repeated 2 KB rows, rotation and sidecar rewrites; small bytes may still incur sync latency. |
| `test/thread-writes-batched.test.ts:82` | 120 streamed updates with 8 KB text. Measures batching; must retain the batching/durability claim. |
| `test/session-engine.test.ts:277` | 650 tool-call updates in the real host/engine fixture, potential repeated ledger writes. |
| `test/inbox-flyout-actions.test.ts:142` | 120 durable sends in a fixture loop; measure cost before changing the claim. |

Useful static scans (read-only, `rg` from the checkout):

```text
rg -n 'repeat\(|alloc\(|createWriteStream|while.*(bytes|size)' test -g '*.test.ts' -g '*.test.tsx'
rg -n 'fsync|datasync|openDurableStore|seedOldLedger' test -g '*.test.ts'
```

Many large `repeat`/`alloc` expressions feed in-memory mocks. They are not evidence of disk writes. Conversely, a
small JSON fixture rewritten with durable sync in a loop can dominate hook time. The process counters include
native writes, stdout and IPC; they do not identify physical filesystem paths. The report keeps CLI, Vitest worker
and other Node/Electron descendant totals separate, so setup/IPC overhead is visible. Non-Node children are not
tracked. The 500 ms discovery interval can miss
short-lived children; missing final reads are explicitly lower bounds. Per-file wall duration includes the isolated
runner startup and observer polling; JSON test durations and the slow-tests table are also retained. Sampled worker
rates lump newly discovered processes' earlier writes into the discovery sample; use the existing machine and
process samplers alongside them, not as an exact per-millisecond physical-disk rate.

The existing slow-tests table's outside-test time includes setup, hooks **and import**. It cannot settle which
individual hook was slow; report the estimate honestly and use an existing targeted probe if that distinction matters.
