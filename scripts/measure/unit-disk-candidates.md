# Unit-suite disk candidates (Tynn #671)

Measured reductions on Standard_D16ads_v5, in genie's logged-on session:

| File | BEFORE worker OS write bytes | Isolated AFTER | Evidence |
| --- | ---: | ---: | --- |
| `program-lookup.test.ts` | 7,314,652,919 | 87,198,385 (-98.8%) | Same 82 cases and real executable bytes; one owned Node image with hard links. Bypass probe: 5 refusal failures / 1 passing execution control. Mark-hook-off probe: 5 positive-control failures / 77 passes. Restored tests passed. |
| `attention-bounded.test.ts` | 195,145,947 | 146,639,924 (-24.9%) | Same full owner-scale input and every assertion; one owned JSON source linked into six cases. All 8 cases pass; source-corruption probe fails only the final hash guard (1 failed / 7 passed). |

These are isolated process transfer counters (including IPC), not physical-disk totals or the full-suite AFTER.
The program-lookup AFTER has one unreadable **other-child** process; its sole measured worker has a successful
final read, with zero unreadable workers and zero discovery errors. Unknown child traffic is excluded, not zero.
Before/after artifacts: queues `1113-125818-43de16`, `1113-133131-f0fcea`, `1113-135457-e66dc9`.

Keep `thread-rotation.test.ts`'s real **512 MiB** latency case: its four <100 ms claims are explicitly about that
history size. Keep the public SDK's **540 MiB** case for the Node string-size boundary. Neither is reduced.
The added rotation guard was proven with rotation disabled: 1 failed / 6 skipped at `549db581`, then the exact
source restored. The guard fails at the segment assertion; the subsequent active-size assertion is not reached
independently. The optional `tailscale-install-signature` reduction is outside this change.

The apparent cold rotation timeout was a runner-session error, not a product/test defect: the same diagnostic
head `f9a45d45` passes 7/7 In-Session (identity sample 328 ms, definitive; first test 693 ms), but fails the first
test over SSH (identity sample 6390 ms, unavailable). Queues `1113-140127-cea8fd` and `1113-141427-f1557a`.
Diagnostic instrumentation was removed; no warm-up, timeout, locking or fsync change is required. Run **every**
Windows check In-Session. Final complete AFTER uses the same D16, default candidates and full suite:

```powershell
'{"phase":"after"}' | Set-Content -Encoding UTF8 ci-measure671.json
In-Session scripts/measure/unit-disk-windows.ps1 85
```

Remove `ci-measure671.json` afterward. Full-suite AFTER totals, burst rate and outside-test time must be taken
from that final-head run, rather than inferred by adding isolated savings.

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

To attribute the remaining volume and measure do-nothing worker IO, run
`In-Session scripts/measure/unit-disk-attribution.ps1 40` on the same D16 after the normal unit prerequisites.
It reuses the first gauge, then runs a temporary baseline (2 s idle for observer visibility) and additional suspects
alone. It does not rerun the full suite or edit existing tests. The baseline file is removed in `finally`.
`program-lookup.test.ts:258` is a strong static lead: 27 real-Windows cases each copy the Node executable three
times in `beforeEach`, plus three extra executable copies (84 total). The wrapper prints the actual Node binary
size and predicted copy bytes. Isolated OS totals must confirm this before treating it as the full-run outlier's
source; the original process CSV contains no test-file mapping.

For an isolated AFTER using the base meter in the logged-on session, the SSH-side job can write:

```powershell
'{"phase":"after","candidates":["test/program-lookup.test.ts"],"skipFull":true}' | Set-Content -Encoding UTF8 ci-measure671.json
In-Session scripts/measure/unit-disk-windows.ps1 40
```

The ignored settings file is read inside that session; no environment forwarding is needed. The original gauge
still runs first, then the requested file, with no full-suite run. Remove the settings file after that job, or use
`{"phase":"after"}` for the default candidates plus full suite. Unknown keys/types and invalid test paths fail.
Environment values explicitly set inside a wrapper take precedence. Effective phase, candidates and skipFull
are saved in metadata, so an isolated result cannot be mistaken for the complete AFTER run.

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
