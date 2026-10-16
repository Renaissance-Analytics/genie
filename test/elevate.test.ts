import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Elevator, PRIVILEGED_STEP_EXIT_BASE, elevationBatchPlan, elevationPlan, exitCodeText, hostsWriteStep, realHostsIo, runElevated, runElevatedBatch, stepOutcome, type ElevationOutcome, type Plan, type PrivilegedStep } from '../src/main/elevate.js';

/**
 * ELEVATION, PER OS — the two things the external-browser path needs root/administrator for: writing
 * the hosts file and installing Genie's CA. Each OS has ONE prompt of its own (UAC via Start-Process -Verb
 * RunAs, macOS's administrator-privileges dialog via osascript, polkit via pkexec) and Genie goes
 * through that prompt, never through a stored password or a shell. Arguments are quoted so a path
 * with a space or an apostrophe arrives as one token; a declined prompt is an error with the
 * tool's own words, never a retry loop.
 */

const trust = {
    command: '/opt/genie/caddy',
    args: ['trust', '--config', '/h/.genie/caddy/Caddyfile', '--adapter', 'caddyfile'],
    env: { XDG_DATA_HOME: '/h/.genie/caddy/data', XDG_CONFIG_HOME: '/h/.genie/caddy/config' },
};

describe('elevationPlan', () => {
    it('linux: pkexec, with env through `env K=V`', () => {
        expect(elevationPlan('linux', trust)).toEqual({
            command: 'pkexec',
            args: ['env', 'XDG_DATA_HOME=/h/.genie/caddy/data', 'XDG_CONFIG_HOME=/h/.genie/caddy/config', '/opt/genie/caddy', 'trust', '--config', '/h/.genie/caddy/Caddyfile', '--adapter', 'caddyfile'],
        });
        expect(elevationPlan('linux', { command: 'cp', args: ['/tmp/h', '/etc/hosts'] })).toEqual({ command: 'pkexec', args: ['cp', '/tmp/h', '/etc/hosts'] });
    });

    it('darwin: osascript "do shell script … with administrator privileges", every token single-quoted for sh and escaped for AppleScript', () => {
        expect(elevationPlan('darwin', trust)).toEqual({
            command: 'osascript',
            args: ['-e', `do shell script "XDG_DATA_HOME='/h/.genie/caddy/data' XDG_CONFIG_HOME='/h/.genie/caddy/config' '/opt/genie/caddy' 'trust' '--config' '/h/.genie/caddy/Caddyfile' '--adapter' 'caddyfile'" with administrator privileges`],
        });
        // An apostrophe closes and reopens the sh quote; the backslash that needs is doubled for AppleScript.
        expect(elevationPlan('darwin', { command: 'cp', args: ["/Users/it's me/h", '/etc/hosts'] }).args[1]).toBe(`do shell script "'cp' '/Users/it'\\\\''s me/h' '/etc/hosts'" with administrator privileges`);
    });

    it('win32: PowerShell Start-Process -Verb RunAs -Wait -PassThru, env set on the launcher, each argument its own double-quoted token, apostrophes doubled — and the ELEVATED exit code is the launcher’s', () => {
        expect(elevationPlan('win32', {
            command: 'C:\\Program Files\\Genie\\resources\\runtime\\caddy.exe',
            args: ['trust', '--config', 'C:\\Users\\me\\.genie\\caddy\\Caddyfile', '--adapter', 'caddyfile'],
            env: { XDG_DATA_HOME: 'C:\\Users\\me\\.genie\\caddy\\data' },
        })).toEqual({
            command: 'powershell',
            args: ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $env:XDG_DATA_HOME='C:\\Users\\me\\.genie\\caddy\\data'; $p = Start-Process -Wait -PassThru -Verb RunAs -FilePath 'C:\\Program Files\\Genie\\resources\\runtime\\caddy.exe' -ArgumentList @('"trust"','"--config"','"C:\\Users\\me\\.genie\\caddy\\Caddyfile"','"--adapter"','"caddyfile"'); if ($null -eq $p) { exit 1 }; exit $p.ExitCode`],
        });
        expect(elevationPlan('win32', { command: 'x.exe', args: ["it's"] }).args[3]).toBe(`$ErrorActionPreference='Stop'; $p = Start-Process -Wait -PassThru -Verb RunAs -FilePath 'x.exe' -ArgumentList @('"it''s"'); if ($null -eq $p) { exit 1 }; exit $p.ExitCode`);
    });

    // The bug this fixes: `Start-Process -Wait` alone returns nothing, so the launcher exited 0 whatever the elevated
    // step did — a certutil that FAILED read as trusted. Without -PassThru there is no process to read a code from.
    it('win32: the launcher can only succeed through the elevated process’s own exit code (no -PassThru = no code = every failure a success)', () => {
        const script = elevationPlan('win32', { command: 'certutil', args: ['-addstore', '-f', 'Root', 'C:\\Users\\me\\.genie\\runtime\\gen-ca\\ca.crt'] }).args[3]!;
        expect(script).toContain('-PassThru');
        expect(script).toMatch(/; exit \$p\.ExitCode$/);
        expect(script.startsWith(`$ErrorActionPreference='Stop'; `)).toBe(true);
        expect(script).toContain("-ArgumentList @('\"-addstore\"','\"-f\"','\"Root\"','\"C:\\Users\\me\\.genie\\runtime\\gen-ca\\ca.crt\"')");
        // No arguments: no empty -ArgumentList (Start-Process refuses an empty array).
        expect(elevationPlan('win32', { command: 'x.exe', args: [] }).args[3]).toBe(`$ErrorActionPreference='Stop'; $p = Start-Process -Wait -PassThru -Verb RunAs -FilePath 'x.exe'; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`);
    });
});

describe('the hosts-file write step', () => {
    it('copies the prepared file over the hosts file — Copy-Item on Windows, cp elsewhere', () => {
        expect(hostsWriteStep('win32', 'C:\\Users\\me\\.genie\\runtime\\hosts.next', 'C:\\Windows\\System32\\drivers\\etc\\hosts')).toEqual({
            command: 'powershell',
            args: ['-NoProfile', '-NonInteractive', '-Command', `Copy-Item -LiteralPath 'C:\\Users\\me\\.genie\\runtime\\hosts.next' -Destination 'C:\\Windows\\System32\\drivers\\etc\\hosts' -Force`],
        });
        expect(hostsWriteStep('linux', '/h/.genie/runtime/hosts.next', '/etc/hosts')).toEqual({ command: 'cp', args: ['/h/.genie/runtime/hosts.next', '/etc/hosts'] });
        expect(hostsWriteStep('darwin', '/h/.genie/runtime/hosts.next', '/etc/hosts')).toEqual({ command: 'cp', args: ['/h/.genie/runtime/hosts.next', '/etc/hosts'] });
    });
});

describe('runElevated', () => {
    it('resolves on exit 0 and rejects with the tool’s own words (or the exit code) otherwise — no retry', async () => {
        const runs: Plan[] = [];
        await expect(runElevated('linux', trust, async (p) => { runs.push(p); return { exitCode: 0, stdout: '' }; })).resolves.toBeUndefined();
        expect(runs).toHaveLength(1);
        await expect(runElevated('linux', trust, async () => ({ exitCode: 126, stdout: 'Error executing command as another user: Request dismissed' }))).rejects.toThrow('Request dismissed');
        await expect(runElevated('linux', trust, async () => ({ exitCode: 1, stdout: '' }))).rejects.toThrow(/exit 1/);
    });

    it('an elevated step that ran and FAILED rejects with its exit code — a Windows HRESULT in hex — and success stays the positive control', async () => {
        const certutil = { command: 'certutil', args: ['-addstore', '-f', 'Root', 'C:\\g\\ca.crt'] };
        // What the Windows launcher now hands back when certutil fails elevated: its code, nothing on stdout.
        await expect(runElevated('win32', certutil, async () => ({ exitCode: -2147024891, stdout: '' }))).rejects.toThrow('certutil -addstore -f Root C:\\g\\ca.crt: the elevated run failed (exit 0x80070005)');
        await expect(runElevated('win32', certutil, async () => ({ exitCode: 5, stdout: '' }))).rejects.toThrow(/exit 5\)$/);
        await expect(runElevated('win32', certutil, async () => ({ exitCode: 0, stdout: '' }))).resolves.toBeUndefined();
        expect(exitCodeText(0x80070005)).toBe('0x80070005');
        expect(exitCodeText(-2147024891)).toBe('0x80070005');
        expect(exitCodeText(1)).toBe('1');
    });
});

describe('ONE prompt for a batch (genie#604): elevationBatchPlan', () => {
    const win = [
        { command: 'certutil', args: ['-addstore', '-f', 'Root', 'C:\\Users\\Jo Example\\.genie\\runtime\\gen-ca\\ca.crt'] },
        hostsWriteStep('win32', 'C:\\Users\\Jo Example\\.genie\\runtime\\hosts.next', 'C:\\Windows\\System32\\drivers\\etc\\hosts'),
    ];
    const decoded = (plan: Plan): string => Buffer.from(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(plan.args[3]!)![1]!, 'base64').toString('utf16le');

    it('win32: ONE Start-Process -Verb RunAs of an encoded script that runs every step in order and exits BASE + the failing step’s index', () => {
        const plan = elevationBatchPlan('win32', win);
        expect(plan.command).toBe('powershell');
        expect(plan.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
        // COUNTED: one RunAs — one prompt — for two steps.
        expect(plan.args[3]!.match(/-Verb RunAs/g) ?? []).toHaveLength(1);
        expect(plan.args[3]).toMatch(/^\$ErrorActionPreference='Stop'; \$p = Start-Process -Wait -PassThru -Verb RunAs -FilePath 'powershell' -ArgumentList @\('-NoProfile','-NonInteractive','-EncodedCommand','[A-Za-z0-9+/=]+'\); if \(\$null -eq \$p\) \{ exit 1 \}; exit \$p\.ExitCode$/);
        expect(decoded(plan).split('\n')).toEqual([
            `& 'certutil' '-addstore' '-f' 'Root' 'C:\\Users\\Jo Example\\.genie\\runtime\\gen-ca\\ca.crt'`,
            'if ($LASTEXITCODE -ne 0) { exit 90 }',
            `& 'powershell' '-NoProfile' '-NonInteractive' '-Command' 'Copy-Item -LiteralPath ''C:\\Users\\Jo Example\\.genie\\runtime\\hosts.next'' -Destination ''C:\\Windows\\System32\\drivers\\etc\\hosts'' -Force'`,
            'if ($LASTEXITCODE -ne 0) { exit 91 }',
            'exit 0',
        ]);
        expect(PRIVILEGED_STEP_EXIT_BASE).toBe(90);
    });

    it('linux: ONE pkexec of /bin/sh running each step, every token single-quoted, a failing step marked on stderr and exiting BASE + its index', () => {
        const steps = [{ command: 'trust', args: ['anchor', '--store', "/home/it's me/ca.crt"] }, { command: 'cp', args: ['/home/user/.genie/runtime/hosts.next', '/etc/hosts'] }];
        const script = `'trust' 'anchor' '--store' '/home/it'\\''s me/ca.crt' || { echo 'genie-privileged-step:0' >&2; exit 90; }; 'cp' '/home/user/.genie/runtime/hosts.next' '/etc/hosts' || { echo 'genie-privileged-step:1' >&2; exit 91; }`;
        expect(elevationBatchPlan('linux', steps)).toEqual({ command: 'pkexec', args: ['/bin/sh', '-c', script] });
        // darwin: the same script inside ONE administrator-privileges dialog, backslashes doubled for AppleScript.
        expect(elevationBatchPlan('darwin', steps)).toEqual({
            command: 'osascript',
            args: ['-e', `do shell script "'trust' 'anchor' '--store' '/home/it'\\\\''s me/ca.crt' || { echo 'genie-privileged-step:0' >&2; exit 90; }; 'cp' '/home/user/.genie/runtime/hosts.next' '/etc/hosts' || { echo 'genie-privileged-step:1' >&2; exit 91; }" with administrator privileges`],
        });
    });

    it('refuses to raise a prompt for no steps', () => {
        expect(() => elevationBatchPlan('win32', [])).toThrow(/no steps/);
    });
});

describe('runElevatedBatch: which step stopped it', () => {
    const steps: PrivilegedStep[] = [
        { id: 'trust', label: 'install Genie’s certificate into the trust store', step: { command: 'certutil', args: ['-addstore', '-f', 'Root', 'C:\\g\\ca.crt'] } },
        { id: 'hosts', label: 'update the hosts file', step: hostsWriteStep('win32', 'C:\\g\\hosts.next', 'C:\\Windows\\System32\\drivers\\etc\\hosts') },
    ];
    const answering = (exitCode: number, stdout = '') => { const plans: Plan[] = []; return { plans, run: async (p: Plan) => { plans.push(p); return { exitCode, stdout }; } }; };

    it('exit 0 → ok, through ONE launch', async () => {
        const r = answering(0);
        expect(await runElevatedBatch('win32', steps, r.run)).toEqual({ ok: true });
        expect(r.plans).toHaveLength(1);
    });

    it('Windows: the step-indexed exit code names the step (its own words do not cross the elevation boundary)', async () => {
        expect(await runElevatedBatch('win32', steps, answering(91).run)).toEqual({ ok: false, failed: { id: 'hosts', label: 'update the hosts file' }, error: 'update the hosts file failed' });
        expect(await runElevatedBatch('win32', steps, answering(90).run)).toMatchObject({ failed: { id: 'trust' } });
    });

    it('macOS: osascript flattens the code to 1, so the stderr marker names the step; the tool’s words are kept, the marker stripped', async () => {
        const r = await runElevatedBatch('darwin', steps, answering(1, 'genie-privileged-step:0\nSecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible. (1)').run);
        expect(r).toEqual({ ok: false, failed: { id: 'trust', label: 'install Genie’s certificate into the trust store' }, error: 'SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible. (1)' });
    });

    it('a declined prompt blames no step — nothing ran — and carries the launcher’s words', async () => {
        expect(await runElevatedBatch('win32', steps, answering(1, 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.').run)).toEqual({
            ok: false, failed: null, error: 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.',
        });
        expect(await runElevatedBatch('linux', steps, answering(126, 'Error executing command as another user: Request dismissed').run)).toEqual({ ok: false, failed: null, error: 'Error executing command as another user: Request dismissed' });
    });

    it('no steps → no launch at all', async () => {
        const r = answering(0);
        expect(await runElevatedBatch('win32', [], r.run)).toEqual({ ok: true });
        expect(r.plans).toEqual([]);
    });
});

describe('stepOutcome', () => {
    const steps = [{ id: 'trust', label: 'install Genie’s certificate into the trust store' }, { id: 'hosts', label: 'update the hosts file' }] as unknown as PrivilegedStep[];
    it('a step before the failing one ran; the failing one and those after it did not', () => {
        const hostsFailed: ElevationOutcome = { ok: false, failed: { id: 'hosts', label: 'update the hosts file' }, error: 'exit 91' };
        expect(stepOutcome(hostsFailed, steps, 'trust')).toEqual({ ok: true });
        expect(stepOutcome(hostsFailed, steps, 'hosts')).toEqual({ ok: false, error: 'exit 91' });
        const trustFailed: ElevationOutcome = { ok: false, failed: { id: 'trust', label: 'install Genie’s certificate into the trust store' }, error: 'exit 90' };
        expect(stepOutcome(trustFailed, steps, 'hosts')).toEqual({ ok: false, error: 'not done: install Genie’s certificate into the trust store failed first in the same prompt (exit 90)' });
        expect(stepOutcome({ ok: false, failed: null, error: 'Request dismissed' }, steps, 'trust')).toEqual({ ok: false, error: 'Request dismissed' });
        expect(stepOutcome({ ok: true }, steps, 'hosts')).toEqual({ ok: true });
    });
});

describe('the Elevator: one prompt at a time', () => {
    it('batches asked for together run one after the other — never two on screen — and an empty batch raises nothing', async () => {
        let open = 0;
        let most = 0;
        const seen: string[][] = [];
        const elevator = new Elevator(async (steps) => {
            seen.push(steps.map((s) => s.id));
            open += 1;
            most = Math.max(most, open);
            await new Promise((r) => setTimeout(r, 5));
            open -= 1;
            return { ok: true };
        });
        const step = (id: string) => ({ id, label: id, step: { command: 'x', args: [] } });
        const results = await Promise.all([elevator.run([step('hosts')]), elevator.run([step('trust')]), elevator.run([])]);
        expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
        expect(seen).toEqual([['hosts'], ['trust']]);
        expect(most).toBe(1);
    });

    it('a launcher that cannot be spawned is a failure no step is blamed for, never a success', async () => {
        const elevator = new Elevator(async () => { throw Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT' }); });
        expect(await elevator.run([{ id: 'hosts', label: 'update the hosts file', step: { command: 'cp', args: [] } }])).toEqual({ ok: false, failed: null, error: 'spawn powershell ENOENT' });
    });
});

describe('realHostsIo', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-hosts-io-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('reads the hosts file (a missing one reads as empty), writes plainly, and stage() prepares hosts.next in the runtime dir and answers the copy step — raising no prompt itself', async () => {
        const hostsPath = join(dir, 'etc-hosts');
        const io = realHostsIo({ platform: 'linux', hostsPath, tmpDir: dir });
        expect(await io.read()).toBe('');
        await io.write('127.0.0.1 localhost\n');
        expect(await io.read()).toBe('127.0.0.1 localhost\n');
        const step = await io.stage('127.0.0.1 localhost\n127.0.0.1 tynn.gen\n::1 tynn.gen\n');
        expect(await readFile(join(dir, 'hosts.next'), 'utf8')).toBe('127.0.0.1 localhost\n127.0.0.1 tynn.gen\n::1 tynn.gen\n');
        expect(step).toEqual({ command: 'cp', args: [join(dir, 'hosts.next'), hostsPath] });
        // Staged, not written: the hosts file is untouched until the batch copies it.
        expect(await io.read()).toBe('127.0.0.1 localhost\n');
    });
});
