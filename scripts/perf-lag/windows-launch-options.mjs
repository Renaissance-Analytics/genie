#!/usr/bin/env node
/**
 * WHAT CAN CUT THE POWERSHELL LAUNCHES, MEASURED BEFORE ANYTHING CHANGES (first-provider-timing: every native launch is PowerShell, 1.4 to 2.3 s each). Run on genie-test-windows, as the
 * normal job and, once the keychain script has made a logged-on session, in that too. It changes nothing in the product and writes only to a temp folder of its own.
 *
 *   node scripts/perf-lag/windows-launch-options.mjs
 *
 * The ACL questions, each answered by a real read of the ACL:
 *   - How long does icacls.exe take to do what the PowerShell script does to a folder?
 *   - A new file in a folder already made private: does inheritance alone leave it owner-only, with the folder's owner?
 *   - A staged file renamed over an existing file that has a foreign grant: does the foreign grant go?
 *   - A file moved in from outside keeps its own ACL, which is why only a file created inside can rely on inheritance. The control.
 * The process table:
 *   - One PowerShell launch per reading, against a long-lived PowerShell answering on stdin: its first reading and its later ones.
 *
 * Prints `### launch-options <step>=<ms>  detail`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'win32') { console.error('Windows only'); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), 'launch-options-'));
const say = (step, ms, detail = '') => console.log(`### launch-options ${step}=${Math.round(ms)}${detail ? `  ${detail}` : ''}`);
const timed = (step, run, show = (out) => '') => { const began = performance.now(); const out = run(); say(step, performance.now() - began, show(out)); return out; };
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
const sddl = (path) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${path}').Sddl`]).trim();
const icaclsOf = (path) => run('icacls', [path]).replace(/\s+/g, ' ').trim();

try {
    const sid = timed('whoami-for-the-sid', () => run('whoami', ['/user', '/fo', 'csv', '/nh']).trim().split(',').pop().replace(/"/g, ''), (s) => s);
    const folder = join(root, 'private');
    mkdirSync(folder);
    timed('icacls-make-a-folder-private', () => run('icacls', [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/q']));
    timed('icacls-set-the-owner', () => run('icacls', [folder, '/setowner', `*${sid}`, '/q']));
    timed('icacls-read-the-folder', () => icaclsOf(folder), (t) => t.slice(0, 160));
    console.log(`--- folder sddl: ${sddl(folder)}`);

    const fresh = join(folder, 'new.json');
    writeFileSync(fresh, 'x');
    console.log(`### launch-options new-file-inherits  icacls: ${icaclsOf(fresh).slice(0, 200)}`);
    console.log(`--- new file sddl: ${sddl(fresh)}`);

    const existing = join(folder, 'existing.json');
    writeFileSync(existing, 'old');
    run('icacls', [existing, '/grant', '*S-1-5-32-545:R', '/q']);
    console.log(`--- existing, with a foreign grant (Users): ${icaclsOf(existing).slice(0, 200)}`);
    const staged = join(folder, 'existing.json.staged.tmp');
    writeFileSync(staged, 'new');
    renameSync(staged, existing);
    console.log(`### launch-options renamed-over  icacls: ${icaclsOf(existing).slice(0, 200)}`);
    console.log(`--- renamed-over sddl: ${sddl(existing)}`);

    const outside = join(root, 'outside.json');
    writeFileSync(outside, 'x');
    const movedIn = join(folder, 'moved-in.json');
    renameSync(outside, movedIn);
    console.log(`### launch-options CONTROL-moved-in-keeps-its-own  icacls: ${icaclsOf(movedIn).slice(0, 220)}`);

    const CIM = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.Name } | Measure-Object | ForEach-Object { $_.Count }";
    timed('process-table-a-launch-per-reading', () => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', CIM]), (o) => `${o.trim()} rows`);
    timed('process-table-a-launch-per-reading-again', () => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', CIM]), (o) => `${o.trim()} rows`);

    const long = spawn('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
    let text = '';
    long.stdout.on('data', (d) => { text += d; });
    const ask = async (step) => {
        const mark = `DONE${Math.random().toString(36).slice(2)}`;
        text = '';
        const began = performance.now();
        long.stdin.write(`${CIM}; '${mark}'\n`);
        while (!text.includes(mark)) {
            if (performance.now() - began > 60_000) throw new Error('the long-lived PowerShell did not answer');
            await new Promise((r) => setTimeout(r, 5));
        }
        say(step, performance.now() - began, `${text.split(/\r?\n/)[0]} rows`);
    };
    await ask('process-table-long-lived-first');
    await ask('process-table-long-lived-second');
    await ask('process-table-long-lived-third');
    long.stdin.end();
    long.kill();
    console.log('### launch-options=PASS');
} catch (error) {
    console.log(`### launch-options=FAIL  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
