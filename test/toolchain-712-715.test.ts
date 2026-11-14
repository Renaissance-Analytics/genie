import { describe, expect, it } from 'vitest';
import { genieUpdates } from '../src/core/toolchain-update.js';
import { HOST_TOOLS, planUpdate, type PackageManager, type Platform } from '../src/core/toolchain.js';

/*
 * Tynn #712 + #715 — two false answers in Settings → Toolchain, both blocking users.
 *
 * #712: codex showed "Broken: ...\npm\codex.cmd points at ...\npm\node.exe, which is not there". npm's generated shim is
 * `IF EXIST "%dp0%\node.exe" (SET "_prog=%dp0%\node.exe") ELSE (SET "_prog=node" ...)`: with no node.exe beside it, cmd
 * runs `node` from PATH. The detector took the first "%dp0%\..." string in the file, the IF EXIST probe, as the target.
 *
 * #715: composer has no ownUpdater, so Update fell to the OS package manager and refused "no package manager found" on a
 * machine without one. Every row that offers Update must have a plan that does not refuse.
 */

const loadRunner = async () => { const path: string = '../src/main/provider-health.js'; return import(path) as Promise<any>; };
const text = (s: string) => new TextEncoder().encode(s);

/** The shim npm writes for a bin whose target is a script (cmd-shim as npm 10/11 emit it; codex.cmd on a real machine). */
const NPM_CODEX_CMD = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    '',
].join('\r\n');

const SHIM = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd';
const SCRIPT = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
const SIBLING_NODE = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node.exe';

function winPorts(files: Record<string, string>, version = 'codex-cli 0.167.1\n') {
    const disk = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), text(v)]));
    const calls: Array<{ binary: string; args: readonly string[] }> = [];
    return {
        calls,
        ports: {
            platform: 'win32' as const, arch: 'x64',
            env: { PATH: 'C:\\Users\\u\\AppData\\Roaming\\npm;C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:\\Users\\u' },
            isFile: (p: string) => disk.has(p.toLowerCase()),
            readText: (p: string) => new TextDecoder().decode(disk.get(p.toLowerCase()) ?? new Uint8Array()),
            readHead: (p: string) => disk.get(p.toLowerCase()) ?? null,
            realpath: (p: string) => p,
            chosen: () => null,
            now: () => 5,
            run: async (binary: string, args: readonly string[]) => {
                calls.push({ binary, args });
                const stdout = args.join(' ').endsWith('--version') ? version : '';
                return { exitCode: 0, stdout, streams: { stdout, stderr: '' } };
            },
        },
    };
}

describe('#712 — npm\'s cmd shim, read the way cmd runs it', () => {
    it('no node.exe beside codex.cmd: it falls through to node on PATH, so codex is NOT broken', async () => {
        const { checkProviderHealth } = await loadRunner();
        const { ports } = winPorts({ [SHIM]: NPM_CODEX_CMD, [SCRIPT]: '#!/usr/bin/env node\n' });
        const h = await checkProviderHealth('codex', ports);
        expect(h.fault).not.toBe('shim-target-missing');
        expect(h.words ?? '').not.toMatch(/node\.exe/);
        expect(h).toMatchObject({ installed: true, version: '0.167.1' });
    });

    it('a node.exe beside the shim is fine too', async () => {
        const { checkProviderHealth } = await loadRunner();
        const { ports } = winPorts({ [SHIM]: NPM_CODEX_CMD, [SCRIPT]: '#!/usr/bin/env node\n', [SIBLING_NODE]: 'MZ' });
        const h = await checkProviderHealth('codex', ports);
        expect(h.fault).not.toBe('shim-target-missing');
        expect(h.installed).toBe(true);
    });

    it('broken only when the script is really gone, and it then names the script, never node.exe', async () => {
        const { checkProviderHealth } = await loadRunner();
        const { ports, calls } = winPorts({ [SHIM]: NPM_CODEX_CMD });
        const h = await checkProviderHealth('codex', ports);
        expect(h).toMatchObject({ fault: 'shim-target-missing', installed: false });
        expect(h.words).toMatch(/codex\.js/);
        expect(h.words).not.toMatch(/node\.exe/);
        expect(calls).toEqual([]);
    });

    it('a shim whose `--version` fails is still reported by the existing check (not-runnable)', async () => {
        const { checkProviderHealth } = await loadRunner();
        const { ports } = winPorts({ [SHIM]: NPM_CODEX_CMD, [SCRIPT]: '#!/usr/bin/env node\n' }, 'nonsense');
        expect(await checkProviderHealth('codex', ports)).toMatchObject({ fault: 'not-runnable' });
    });
});

describe('#715 — every row that offers Update has a plan that does not refuse', () => {
    const platforms: Platform[] = ['win32', 'linux'];
    const managers: PackageManager[] = ['winget', 'apt', 'dnf', 'brew'];

    it('composer updates itself with `composer self-update`, with or without a package manager', () => {
        for (const platform of platforms) {
            for (const packageManager of [null, ...managers]) {
                expect(planUpdate({ tool: 'composer', platform, packageManager })).toMatchObject({ command: 'composer self-update' });
            }
        }
    });

    it('sweep: no HOST_TOOLS row is offered an Update its plan then refuses, except the tools that need an OS package manager', () => {
        // These really are updated by the OS package manager and nothing else: with none, or with one that has no id for them, Update is refused in words.
        const NEEDS_PACKAGE_MANAGER = new Set(['git', 'docker']);
        const refusals: string[] = [];
        for (const tool of HOST_TOOLS) {
            for (const platform of platforms) {
                // A Genie-managed language updates through Genie's own installer, never through planUpdate.
                if (genieUpdates(tool.name, platform)) continue;
                if (NEEDS_PACKAGE_MANAGER.has(tool.name)) continue;
                for (const packageManager of [null, ...managers]) {
                    const plan = planUpdate({ tool: tool.name, platform, packageManager });
                    if ('refused' in plan) refusals.push(`${tool.name} on ${platform} with ${packageManager}: ${plan.refused}`);
                }
            }
        }
        expect(refusals).toEqual([]);
    });

    it('the tools that need a package manager are exactly the ones with no updater of their own', () => {
        const need = HOST_TOOLS.filter((t) => t.ownUpdater === undefined && !genieUpdates(t.name, 'linux') && !genieUpdates(t.name, 'win32')).map((t) => t.name).sort();
        expect(need).toEqual(['docker', 'git']);
    });

    it('positive control: the sweep sees a tool without an updater refuse when no package manager exists', () => {
        expect(planUpdate({ tool: 'git', platform: 'linux', packageManager: null })).toMatchObject({ refused: expect.stringContaining('no package manager') });
    });
});
