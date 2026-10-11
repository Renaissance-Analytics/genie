import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { elevationPlan, hostsWriteStep, realHostsIo, runElevated, type Plan } from '../src/main/elevate.js';

/**
 * ELEVATION, PER OS — the two things the external-browser path needs root/administrator for: writing
 * the hosts file and `caddy trust`. Each OS has ONE prompt of its own (UAC via Start-Process -Verb
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

    it('win32: PowerShell Start-Process -Verb RunAs -Wait, env set on the launcher, each argument its own double-quoted token, apostrophes doubled', () => {
        expect(elevationPlan('win32', {
            command: 'C:\\Program Files\\Genie\\resources\\runtime\\caddy.exe',
            args: ['trust', '--config', 'C:\\Users\\me\\.genie\\caddy\\Caddyfile', '--adapter', 'caddyfile'],
            env: { XDG_DATA_HOME: 'C:\\Users\\me\\.genie\\caddy\\data' },
        })).toEqual({
            command: 'powershell',
            args: ['-NoProfile', '-NonInteractive', '-Command', `$env:XDG_DATA_HOME='C:\\Users\\me\\.genie\\caddy\\data'; Start-Process -Wait -Verb RunAs -FilePath 'C:\\Program Files\\Genie\\resources\\runtime\\caddy.exe' -ArgumentList @('"trust"','"--config"','"C:\\Users\\me\\.genie\\caddy\\Caddyfile"','"--adapter"','"caddyfile"')`],
        });
        expect(elevationPlan('win32', { command: 'x.exe', args: ["it's"] }).args[3]).toBe(`Start-Process -Wait -Verb RunAs -FilePath 'x.exe' -ArgumentList @('"it''s"')`);
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
});

describe('realHostsIo', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-hosts-io-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('reads the hosts file (a missing one reads as empty), writes plainly, and writeElevated prepares hosts.next in the runtime dir then runs the copy through the OS prompt', async () => {
        const hostsPath = join(dir, 'etc-hosts');
        const plans: Plan[] = [];
        const io = realHostsIo({ platform: 'linux', hostsPath, tmpDir: dir, run: async (p) => { plans.push(p); return { exitCode: 0, stdout: '' }; } });
        expect(await io.read()).toBe('');
        await io.write('127.0.0.1 localhost\n');
        expect(await io.read()).toBe('127.0.0.1 localhost\n');
        await io.writeElevated('127.0.0.1 localhost\n127.0.0.1 tynn.gen\n');
        expect(await readFile(join(dir, 'hosts.next'), 'utf8')).toBe('127.0.0.1 localhost\n127.0.0.1 tynn.gen\n');
        expect(plans).toEqual([{ command: 'pkexec', args: ['cp', join(dir, 'hosts.next'), hostsPath] }]);
    });

    it('a declined prompt rejects with the reason; the hosts file is untouched', async () => {
        const hostsPath = join(dir, 'etc-hosts');
        const io = realHostsIo({ platform: 'linux', hostsPath, tmpDir: dir, run: async () => ({ exitCode: 126, stdout: 'Request dismissed' }) });
        await io.write('127.0.0.1 localhost\n');
        await expect(io.writeElevated('x')).rejects.toThrow('Request dismissed');
        expect(await io.read()).toBe('127.0.0.1 localhost\n');
    });
});
