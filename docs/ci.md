# Where Genie's CI runs

All of Genie's testing runs on machines we run, never on GitHub Actions (the owner, 2026-11-11: "ALL CI IS LOCAL OR IN
AZURE"). GitHub builds, signs and publishes a release; it runs no tests and gates no merge.

**The gate before a tag** is a green `scripts/ci/linux.sh` on omarchy-test AND a green `scripts/ci/windows.ps1` on an Azure
Windows VM, on the commit being tagged. `release.yml` no longer runs the suite before it builds: a tag pushed without both
gates green ships untested code.

| Platform | Machine | Entry |
| --- | --- | --- |
| Linux | the `omarchy-test` VirtualBox VM: real Omarchy, the Hyprland session, restored from its `base` snapshot every run | `bash scripts/ci/linux.sh` |
| Windows | a fresh Azure VM per run: Windows Server 2025, the standard user `genie` (not an Administrator), deleted after | `scripts/ci/windows.ps1`, in genie's logged-on session |

The machines are started from the envelope that holds this repository, not from here: `scripts/omarchy-run.sh` for
Linux and `scripts/azure/run-job.sh` for Windows. One Linux run at a time. Never run either script on a person's
desktop: the rows open real windows, start real hosts, write to `~/.genie` and end processes.

## Running it

```bash
# Linux, from the envelope
OMARCHY_FETCH=ci-out=<local dir> scripts/omarchy-run.sh <genie checkout> 'bash scripts/ci/linux.sh'
#   bash scripts/ci/linux.sh --only unit,smoke    only these rows
#   bash scripts/ci/linux.sh --from local-door    this row and every row after it
#   bash scripts/ci/linux.sh --list               the rows, in order
```

```powershell
# Windows: the job file given to the envelope's scripts/azure/run-job.sh (AZ_FETCH="ci-out;smoke-out" brings the logs home)
In-Session scripts/ci/windows.ps1 150
# In-Session passes no arguments; a shorter run writes its rows first:
Set-Content ci-rows.txt '-Only unit,smoke'; In-Session scripts/ci/windows.ps1 60
```

A run with `--only`/`--from` (`-Only`/`-From`) first runs the setup its rows stand on (`deps`, `electron-binary`, and
`build` when a row needs the built app), each as a row of its own.

## Reading a run

- One line per row: `ROW <name> PASS|FAIL <seconds>`, with `(not run: <why>)` when something the row needed failed.
- `NOTE` lines: what was measured differently here (for example `MEASURED ON A SOFTWARE-RENDERED MACHINE`, below).
- `NOT RUN ON LINUX <file> (<reason>)`: a test file that runs on Windows only; it carries `// CI: WINDOWS ONLY (<reason>)`
  and `test/ci-windows-only-files.test.ts` holds that.
- Linux only: a `MACHINE before <row>` line (load, free memory, swap, the kernel's pressure figures, Genie processes still
  alive), the `UNIT` and `DOCKER` lines, and a `CLOCK` line (wall clock against uptime over the run).
- Windows only: a final `ROWS n of n reported: …` line; a row with no result fails the run.
- The last line: `CI LINUX PASS|FAIL` or `CI WINDOWS PASS|FAIL`; the exit code is non-zero on any failure.
- Every row's whole output is in `ci-out/<row>.log`; what the setup wrote is in `ci-out/setup/`; the row scripts' own
  app logs and results are in `smoke-out/`.

## What differs from the old ci.yml jobs

- **The display.** Linux windows open on the Hyprland session, as on the owner's machines. `CI_DISPLAY=xvfb` puts them on
  a 1440x900 virtual X screen instead.
- **The test-machine marker.** GitHub's `CI=true` is not set. The scripts say the machine is a test machine once, when its
  user is `genie` or `GENIE_TEST_MACHINE=1` is given, and set the row scripts' own allow variables from that.
- **Software rendering.** On a VM with no GPU (omarchy-test, the Azure VMs) the idle pass alone reaches ui-lag's and
  artboard's absolute time bounds. There (`GENIE_CI_RENDERING=software`, detected or given) those absolute bounds are
  judged against the same run's idle pass; their within-run ratios and byte budgets are judged as everywhere.
- **Unit workers (Linux).** Three eighths of the cores, at least 2 (3 on omarchy-test). `CI_UNIT_WORKERS` overrides.
- **flows and zip64** always run on Linux: there is no base commit to diff against in a shipped tree.

## The GitHub workflows

| Workflow | What it does |
| --- | --- |
| `release.yml` | for a `v*` tag: checks the tag against `package.json`, typechecks, builds each platform into a draft release, signs and verifies Windows, writes the notes; the release stays a draft. No tests. |
| `release-published.yml` | when the owner publishes a release: closes the issues it ships |
| `sign-test.yml` | a push to `next/release-signing` (or by hand): a signing trial behind the protected environment's approval |
| `deps-drift.yml` | daily: drift of the pinned `@particle-academy` packages, and known advisories against them (a check, not the suite) |

Removed: `ci.yml` (every test job; its rows are `scripts/ci/linux.sh` and `scripts/ci/windows.ps1`) and `signing-guards.yml`
(the signing and release-workflow unit tests, which are in the unit row of both scripts).
