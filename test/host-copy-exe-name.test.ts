import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { windowsFunction } from './helpers/ci-scripts.js';
import { hostExecutableName, materializeHostRuntime, runtimeFiles, type HostRuntimeInput } from '../src/main/host-runtime.js';

/*
 * GENIE-HOST'S COPY IS NOT NAMED AS THE INSTALL IS (Tynn #1036 P6-1, hardening). electron-builder's installer ends the app
 * it replaces by path when PowerShell is there (allowOnlyOneInstallerInstance.nsh FIND_PROCESS / KILL_PROCESS: processes
 * whose path starts with $INSTDIR), and BY NAME when it is not: `taskkill /IM Genie.exe`. The host's copy under
 * ~/.genie/host/ was named Genie.exe too (`basename(execPath)`), so that fallback ended genie-host on a client-only
 * install. The copy's executable is genie-host.exe (genie-host elsewhere): Electron finds what it needs beside its binary
 * by folder, not by name. In a NEW folder, runtime-<electron>-host, so a complete copy of the old layout, whose binary is
 * named as the install's, is never run again.
 */

let root: string;
function write(file: string, text = 'x'): void { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }

function install(platform: NodeJS.Platform): HostRuntimeInput {
    const dist = join(root, 'install');
    const exe = join(dist, platform === 'win32' ? 'Genie.exe' : 'genie');
    write(exe, 'binary');
    for (const f of runtimeFiles(platform)) write(join(dist, f), f);
    const app = join(dist, 'resources', 'app');
    write(join(app, 'dist', 'main', 'host.js'), 'host');
    write(join(app, 'package.json'), '{"type":"module"}');
    const unpacked = join(dist, 'resources', 'app.unpacked');
    write(join(unpacked, 'node_modules', '@particle-academy', 'prism-acp', 'native', 'win32-x64', 'prism-acp-supervisor.exe'), 'supervisor');
    return { packaged: true, platform, arch: 'x64', execPath: exe, electronVersion: '45.2.2', appRoot: app, unpackedRoot: unpacked, hostHash: 'abc123', genieHome: join(root, 'home'), log: () => {} };
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'host-exe-name-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('the name of genie-host’s executable', () => {
    it('genie-host.exe on Windows, genie-host elsewhere: never the install’s name', () => {
        expect(hostExecutableName('win32')).toBe('genie-host.exe');
        expect(hostExecutableName('linux')).toBe('genie-host');
        expect(hostExecutableName('darwin')).toBe('genie-host');
    });

    for (const platform of ['win32', 'linux'] as const) {
        it(`${platform}: the copy is runtime-<electron>-host/${hostExecutableName(platform)}, the install’s binary byte for byte, and the host is started from it`, async () => {
            const input = install(platform);
            const got = await materializeHostRuntime(input);
            expect(got.error).toBeNull();
            expect(got.execPath).toBe(join(input.genieHome, 'host', 'runtime-45.2.2-host', hostExecutableName(platform)));
            expect(basename(got.execPath)).not.toBe(basename(input.execPath));
            expect(readFileSync(got.execPath, 'utf8')).toBe('binary');
            // Beside it, by folder: what Electron reads to run.
            for (const f of runtimeFiles(platform)) expect(existsSync(join(dirname(got.execPath), f)), f).toBe(true);
            // No copy under the install's name: nothing of the host answers to it.
            expect(existsSync(join(dirname(got.execPath), basename(input.execPath)))).toBe(false);
        });
    }

    it('a complete copy of the OLD layout (runtime-<electron>/Genie.exe) is never run: the new folder is made, the old one left', async () => {
        const input = install('win32');
        const old = join(input.genieHome, 'host', 'runtime-45.2.2');
        write(join(old, 'Genie.exe'), 'an older copy, named as the install');
        for (const f of runtimeFiles('win32')) write(join(old, f), f);
        write(join(old, '.complete'), '');
        const got = await materializeHostRuntime(input);
        expect(got.error).toBeNull();
        expect(got.copied).toBe(true);
        expect(dirname(got.execPath)).toBe(join(input.genieHome, 'host', 'runtime-45.2.2-host'));
        expect(basename(got.execPath)).toBe('genie-host.exe');
        // An old host may still run on it: left where it is.
        expect(readFileSync(join(old, 'Genie.exe'), 'utf8')).toBe('an older copy, named as the install');
    });

    it('a second launch keeps the renamed copy: nothing copied again', async () => {
        const input = install('win32');
        await materializeHostRuntime(input);
        const again = await materializeHostRuntime(input);
        expect(again.copied).toBe(false);
        expect(basename(again.execPath)).toBe('genie-host.exe');
    });
});

describe('what knows Genie’s processes by name still knows the host by its new one', () => {
    it('the Windows rows’ leftover guard names genie-host (scripts/ci/windows.ps1 Find-GenieLeftovers)', () => {
        const name = hostExecutableName('win32').replace(/\.exe$/, '');
        expect(windowsFunction('Find-GenieLeftovers')).toContain(`'${name}'`);
    });

    it('the Linux rows’ reap finds it by its copy’s folder and by its name (scripts/ci/linux.sh)', () => {
        const linux = readFileSync('scripts/ci/linux.sh', 'utf8');
        const reap = linux.split(/\r?\n/).find((l) => l.includes('pgrep -f --') && l.includes('/\\.genie/host/')) ?? '';
        expect(reap).toContain(hostExecutableName('linux'));
    });

    it('the packaged app’s row checks the host runs from runtime-*-host as genie-host.exe (scripts/ci/windows.ps1)', () => {
        const row = windowsFunction('Row-packaged-launcher');
        expect(row).toContain('genie-host.exe');
        expect(row).toMatch(/runtime-\*-host/);
    });
});
