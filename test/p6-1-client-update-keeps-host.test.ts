import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyUpdate } from '../src/core/update-kind.js';
import { waitForGenieGone } from '../src/main/updater-helper.js';
import { hostInstallDir, hostRunsFromCopy } from '../src/main/updates-host.js';
import type { RunningProcess } from '../src/main/upgrade.js';

/*
 * HOST SPLIT P6-1 (Tynn #1036, task #1498): A CLIENT-ONLY UPDATE LEAVES GENIE-HOST AND ITS AGENTS RUNNING.
 * genie-host runs from its own copy under ~/.genie/host/ (P6, #1545). It told its updater that the install was the folder it
 * runs from, `dirname(process.execPath)`, which is the COPY. The helper's wait and the teardown scan look for Genie still
 * running under that folder; on a client-only install genie-host itself is running there, so the helper waited out its
 * bound and refused ("the update was not installed"), and a full install never scanned the real install. And a host that
 * could not be copied runs FROM the install, so no update can leave it running: such an update is never client-only.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const code = (path: string) => readFileSync(resolve(root, path), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

// Linux-shaped paths; the same holds with Windows ones (case-insensitive, below).
const INSTALL = '/opt/Genie';
const COPY = '/home/u/.genie/host/runtime-41.2.0';
const env = { GENIE_INSTALL_EXEC: join(INSTALL, 'genie') };
const HOST_EXEC = join(COPY, 'genie');

describe('the install the updater replaces is the window’s, never the host’s copy', () => {
    it('with the window’s executable named: its folder', () => {
        expect(hostInstallDir(env, HOST_EXEC)).toBe(INSTALL);
    });

    it('with none (a host started in place, a dev run): the host’s own folder, as before', () => {
        expect(hostInstallDir({}, join(INSTALL, 'genie'))).toBe(INSTALL);
        expect(hostInstallDir({ GENIE_INSTALL_EXEC: '' }, join(INSTALL, 'genie'))).toBe(INSTALL);
    });

    it('whether the host runs from its copy: yes from ~/.genie/host/, no from the install, no with nothing named', () => {
        expect(hostRunsFromCopy(env, HOST_EXEC)).toBe(true);
        expect(hostRunsFromCopy(env, join(INSTALL, 'genie'))).toBe(false);
        expect(hostRunsFromCopy({}, HOST_EXEC)).toBe(false);
    });
});

describe('a client-only install: the helper does not wait for genie-host running from its copy', () => {
    // The table as the helper reads it, once the window has gone: genie-host from its copy (its parent the window, gone),
    // its spawn host under it, and the helper itself, started FROM THE INSTALL by the host (#1545).
    const HOST = 4100, SPAWN = 4101, HELPER = 4200, WINDOW = 4000;
    const table: RunningProcess[] = [
        { pid: HOST, executable: HOST_EXEC, parentPid: WINDOW, commandLine: `${HOST_EXEC} --genie-host` },
        { pid: SPAWN, executable: HOST_EXEC, parentPid: HOST, commandLine: `${HOST_EXEC} --spawn-host` },
        { pid: HELPER, executable: join(INSTALL, 'genie'), parentPid: HOST, commandLine: `${join(INSTALL, 'genie')} --updater` },
    ];
    const wait = (installDir: string) => {
        let t = 0;
        return waitForGenieGone({
            wait: { pids: [WINDOW], installDir, boundMs: 2_000 },
            ownPid: HELPER,
            processes: async () => table,
            alive: (pid) => pid !== WINDOW,
            sleep: async (ms) => { t += ms; },
            now: () => t,
            caseInsensitive: false,
        });
    };

    it('scanning the install (genie-host’s wiring now): the window gone is enough; the host and its children stay', async () => {
        expect(await wait(hostInstallDir(env, HOST_EXEC))).toEqual({ gone: true });
    });

    it('CONTROL, the bug: scanning the copy (the folder the host runs from) waits out the bound and names genie-host', async () => {
        const said = await wait(COPY);
        expect(said.gone).toBe(false);
        expect((said as { words: string }).words).toMatch(new RegExp(`pid ${HOST}\\b`));
    });

    it('wired: genie-host names the install to its updater, and whether it runs from its copy', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/installDir: hostInstallDir\(process\.env, process\.execPath\),/);
        expect(host).not.toMatch(/installDir: dirname\(process\.execPath\)/);
        expect(host).toMatch(/running: \{ build, protocol: ENGINE_PROTOCOL, fromCopy: hostRunsFromCopy\(process\.env, process\.execPath\) \}/);
    });
});

describe('a host not running from its copy is never kept through an install', () => {
    const offered = { hostHash: 'abcdef012345', engineProtocol: 7 };
    const running = { build: '2.0.0-beta.66+abcdef012345', protocol: 7 };

    it('the same host, run from its copy: client-only', () => {
        expect(classifyUpdate(offered, { ...running, fromCopy: true })).toEqual({ kind: 'client-only' });
    });

    it('the same host, run from the install (its copy failed): full, and why', () => {
        expect(classifyUpdate(offered, { ...running, fromCopy: false })).toEqual({ kind: 'full', why: expect.stringMatching(/runs from the install/) });
    });

    it('CONTROL: an older host that does not say keeps today’s answer', () => {
        expect(classifyUpdate(offered, running)).toEqual({ kind: 'client-only' });
    });
});
