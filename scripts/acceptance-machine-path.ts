/**
 * ACCEPTANCE — GENIE'S DEFAULTS ON THE MACHINE'S OWN PATH, FOR REAL, AND UNDONE EXACTLY (plan TC3b). Test VM only.
 *
 * Linux/macOS: a temporary HOME with known .profile and .bashrc → Apply → a real LOGIN shell (`bash -lc`) sees the
 * entries first on its PATH → Undo → both files are byte-identical to what they were (sha256).
 * Windows: the VM's real HKCU\Environment Path → Apply → the RAW value has the entries first and the original after them,
 * still REG_EXPAND_SZ, and its %USERPROFILE% entries still EXPAND → Undo → the raw value is identical to the original and
 * still REG_EXPAND_SZ.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-machine-path.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMachinePath, machinePathStatus, nodeMachinePathFs, removeMachinePath, type MachinePathPorts } from '../src/main/machine-path.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 120_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const ps = (cmd: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).replace(/\r?\n$/, '');

async function linux(): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'genie-mp-home-'));
    writeFileSync(join(home, '.profile'), 'export GENIE_TEST_PROFILE=1\n');
    writeFileSync(join(home, '.bashrc'), '# my bashrc\nalias ll="ls -l"');   // no trailing newline, on purpose
    const before = { profile: sha(join(home, '.profile')), bashrc: sha(join(home, '.bashrc')) };
    const entries = [join(home, 'genie2-toolchain', 'current', 'node', 'bin'), join(home, 'genie2-toolchain', 'current', 'go', 'bin')];
    const ports: MachinePathPorts = { platform: process.platform as 'linux', home, entries, fs: nodeMachinePathFs(), run };

    console.log('1. Apply');
    const r = await applyMachinePath(true, ports);
    check(r.kind === 'applied', 'applied', JSON.stringify(r));
    check((await machinePathStatus(ports)).applied, 'status: applied');
    const loginPath = execFileSync('bash', ['-lc', 'echo "$PATH"'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin' } }).trim();
    check(loginPath.startsWith(entries.join(':')), 'a real login shell has the entries FIRST on its PATH', loginPath.slice(0, 160));
    console.log('2. Undo');
    check((await removeMachinePath(ports)).kind === 'removed', 'removed');
    check(sha(join(home, '.profile')) === before.profile, '.profile is byte-identical to before');
    check(sha(join(home, '.bashrc')) === before.bashrc, '.bashrc (no trailing newline) is byte-identical to before');
    check(!(await machinePathStatus(ports)).applied, 'status: not applied');
}

async function windows(): Promise<void> {
    const readRaw = () => ps("(Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')");
    const kind = () => ps("(Get-Item -LiteralPath 'HKCU:\\Environment').GetValueKind('Path')");
    // A %USERPROFILE% entry must be there to prove it survives; add one the way Windows itself writes it, if absent.
    let original = readRaw();
    if (!/%USERPROFILE%/i.test(original)) {
        ps(`Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'Path' -Value '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps${original ? `;${original.replace(/'/g, "''")}` : ''}' -Type ExpandString`);
        original = readRaw();
    }
    check(/%USERPROFILE%/i.test(original) && kind() === 'ExpandString', 'control: the user PATH holds a %USERPROFILE% entry, as REG_EXPAND_SZ', `${kind()}: ${original.slice(0, 120)}`);
    const tc = join(process.env['USERPROFILE'] ?? 'C:\\Users\\genie', '.genie', 'genie2-toolchain', 'current');
    const entries = [join(tc, 'node'), join(tc, 'go', 'bin'), join(tc, 'php')];
    const ports: MachinePathPorts = { platform: 'win32', home: process.env['USERPROFILE'] ?? '', entries, fs: nodeMachinePathFs(), run };

    console.log('1. Apply');
    const r = await applyMachinePath(true, ports);
    check(r.kind === 'applied', 'applied', JSON.stringify(r));
    const after = readRaw();
    check(after === `${entries.join(';')};${original}`, 'the RAW value: entries first, the original after them, byte-for-byte', after.slice(0, 200));
    check(kind() === 'ExpandString', 'still REG_EXPAND_SZ');
    const expanded = ps("[Environment]::GetEnvironmentVariable('Path','User')");
    check(/\\AppData\\Local\\Microsoft\\WindowsApps/i.test(expanded) && !/%USERPROFILE%/i.test(expanded), 'its %USERPROFILE% entry still EXPANDS', expanded.slice(0, 200));
    check(expanded.toLowerCase().startsWith(entries[0]!.toLowerCase()), 'a new process reading the user PATH sees the entries first');
    console.log('2. Apply again, then Undo');
    await applyMachinePath(true, ports);
    check(readRaw() === after, 'applying twice changes nothing');
    check((await removeMachinePath(ports)).kind === 'removed', 'removed');
    check(readRaw() === original, 'the RAW value is identical to the original');
    check(kind() === 'ExpandString', 'still REG_EXPAND_SZ after Undo');
}

async function main(): Promise<void> {
    if (process.platform === 'win32') await windows(); else await linux();
    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
