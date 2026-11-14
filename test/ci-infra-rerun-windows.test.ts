// CI: WINDOWS ONLY (it runs windows.ps1's row loop in Windows PowerShell 5.1)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/*
 * STALL-AWARE ROWS, WINDOWS (Tynn #660): windows.ps1's row loop, as test/ci-infra-rerun-linux.test.ts holds linux.sh's.
 * A row that FAILS while the machine sampler (scripts/ci/machine-sampler.ps1) recorded a stall during it is marked INFRA
 * and run once more on the same machine; a row that fails without a stall is never run again; a row blocked by an
 * earlier row's need is not rerun; the summary names the INFRA rows and whether the rerun passed. The 62c gates' false
 * reds (safe-mode, packaged-launcher, artboard on D8ads_v5) are what it is for.
 *
 * Runs windows.ps1's OWN loop (between `# >>> THE ROW LOOP` and `# <<< THE ROW LOOP`) in Windows PowerShell 5.1, the
 * engine In-Session runs the script with, with stub rows and a samples file written here.
 */

const root = join(__dirname, '..');
const source = readFileSync(join(root, 'scripts', 'ci', 'windows.ps1'), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
const start = source.indexOf('\n# >>> THE ROW LOOP');
const end = source.indexOf('\n# <<< THE ROW LOOP');
const loop = start > -1 && end > start ? source.slice(start + 1, end) : '';

/** Samples every 2 s from 60 s ago to 120 s ahead: stalled (disk queue 8, CPU 3 %) or quiet. */
function samples(stalled: boolean): string {
    const now = Date.now();
    const lines = [];
    for (let t = now - 60000; t <= now + 120000; t += 2000) lines.push(`MACHINE ${t} gap=2000 disk_q=${stalled ? 8 : 0} cpu=3 disk_ms=30`);
    return lines.join('\n') + '\n';
}

const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

function runLoop(samplesText: string | null): { out: string; count: (row: string) => number } {
    const dir = mkdtempSync(join(tmpdir(), 'ci-infra-win-'));
    if (samplesText !== null) writeFileSync(join(dir, 'machine-samples.log'), samplesText);
    const script = `
$ErrorActionPreference = 'Continue'
Set-Location ${ps(root)}
$Repo = ${ps(root)}
$Out = ${ps(dir)}
$Setup = Join-Path $Out 'setup'
New-Item -ItemType Directory -Force $Setup | Out-Null
$MachineSamples = Join-Path $Out 'machine-samples.log'
$script:Failed = @(); $script:Notes = @(); $script:Blocked = ''
$script:Installed = ''; $script:Electron = ''; $script:Built = ''; $script:Machine = ''; $script:AppState = ''; $script:App = $null
function Ceiling([string]$name) { 60 }
function Start-Watchdog([int]$limit, [string]$mark, [string]$token) { [pscustomobject]@{ HasExited = $true; Id = 0 } }
function Stop-App { }
function Block([string]$why) { $script:Blocked = $why; Write-Output "--- $why"; throw "NOT RUN: $why" }
function Ran([string]$n) { Add-Content -Path (Join-Path $Out "ran-$n") -Value x }
function Count([string]$n) { @(Get-Content (Join-Path $Out "ran-$n")).Count }
function Row-ok { Ran ok }
function Row-flaky { Ran flaky; if ((Count flaky) -lt 2) { throw 'flaky failed' } }
function Row-broken { Ran broken; throw 'the broken row' }
function Row-cached { Ran cached; Block 'npm ci failed' }
function Row-needs {
    Ran needs
    if ($script:Built -eq 'ok') { return }
    if ($script:Built) { Block $script:Built }
    $script:Built = 'the build failed'
    if ((Count needs) -ge 2) { $script:Built = 'ok'; return }
    Block $script:Built
}
${loop}
$selected = @('ok', 'flaky', 'broken', 'cached', 'needs')
Invoke-Rows
Write-InfraSummary
Write-Output "FAILED: $($script:Failed -join ' ')"
`;
    const file = join(dir, 'loop.ps1');
    writeFileSync(file, `﻿${script}`);
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 120000 });
    const out = `${r.stdout}${r.stderr}`.replace(/\r\n/g, '\n');
    const count = (row: string) => (existsSync(join(dir, `ran-${row}`)) ? readFileSync(join(dir, `ran-${row}`), 'utf8').trim().split(/\r?\n/).length : 0);
    return { out, count };
}

describe.skipIf(process.platform !== 'win32')('windows.ps1: stall-aware rows', () => {
    it('has the loop between its markers', () => {
        expect(loop).toMatch(/\nfunction Invoke-Rows \{/);
        expect(loop).toMatch(/\nfunction Write-InfraSummary \{/);
    });

    describe('the machine stalled during the rows', () => {
        let out = '';
        let count: (row: string) => number = () => -1;
        beforeAll(() => { ({ out, count } = runLoop(samples(true))); }, 120000);
        it('a row that failed during the stall is marked INFRA, run once more, and passes on its rerun', () => {
            expect(out).toMatch(/^INFRA flaky FAIL \d+: the machine stalled during the row \(STALL disk /m);
            expect(count('flaky')).toBe(2);
            expect(out).toMatch(/^ROW flaky PASS \d+ \(INFRA: the first run failed during a machine stall; the rerun passed\)$/m);
        });
        it('a row that fails again is run ONCE more only, and fails, saying so', () => {
            expect(count('broken')).toBe(2);
            expect(out).toMatch(/^ROW broken FAIL \d+ \(INFRA: the first run failed during a machine stall; the rerun failed too\)$/m);
        });
        it('a row blocked by an earlier need is not its own failure: not INFRA, not rerun', () => {
            expect(count('cached')).toBe(1);
            expect(out).not.toMatch(/^INFRA cached/m);
            expect(out).toMatch(/^ROW cached FAIL \d+ \(not run: npm ci failed\)$/m);
        });
        it('a row whose own need failed in it is rerun with that need asked again', () => {
            expect(count('needs')).toBe(2);
            expect(out).toMatch(/^ROW needs PASS \d+ \(INFRA: the first run failed during a machine stall; the rerun passed\)$/m);
        });
        it('a passing row runs once', () => {
            expect(count('ok')).toBe(1);
            expect(out).toMatch(/^ROW ok PASS \d+$/m);
        });
        it('the summary names the INFRA rows and their reruns; the run fails on the rows that failed in the end', () => {
            expect(out).toMatch(/^INFRA ROWS: flaky \(rerun PASS\) broken \(rerun FAIL\) needs \(rerun PASS\)$/m);
            expect(out).toMatch(/^FAILED: broken cached$/m);
        });
    });

    describe('CONTROL: the machine did not stall', () => {
        let out = '';
        let count: (row: string) => number = () => -1;
        beforeAll(() => { ({ out, count } = runLoop(samples(false))); }, 120000);
        it('a failed row is never rerun: each ran once, and the failure is the row\'s', () => {
            expect(count('flaky')).toBe(1);
            expect(count('broken')).toBe(1);
            expect(count('needs')).toBe(1);
            expect(out).toMatch(/^ROW flaky FAIL \d+$/m);
            expect(out).toMatch(/^ROW broken FAIL \d+$/m);
            expect(out).not.toMatch(/^INFRA \S+ FAIL/m);
        });
        it('says the sampler saw no stall, with the count of samples it read (the gauge)', () => {
            expect(out).toMatch(/^NO STALL in \d+ samples/m);
        });
        it('the summary says there were no INFRA rows', () => {
            expect(out).toMatch(/^INFRA ROWS: none$/m);
            expect(out).toMatch(/^FAILED: flaky broken cached needs$/m);
        });
    });

    describe('no sampler ran', () => {
        let out = '';
        let count: (row: string) => number = () => -1;
        beforeAll(() => { ({ out, count } = runLoop(null)); }, 120000);
        it('nothing is rerun, and the missing samples are said', () => {
            expect(count('flaky')).toBe(1);
            expect(out).toMatch(/NO SAMPLES/);
        });
    });
});
