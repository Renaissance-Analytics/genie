import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner, StreamHandle } from '../container-runtime';
import { DEFAULT_TOOLCHAIN } from '../toolchain-detect';
import { inspectToolchain } from '../toolchain-setup';

/**
 * `inspectToolchain` is the one call the first-run wizard (and its IPC) makes to
 * answer "what does this machine have, what will you install, and what will it
 * cost?" — the composition of detect → available-managers → plan → consent into
 * a single reviewable object. It runs BEFORE any consent, installs nothing, and
 * inherits the never-throws contract of every unit it composes.
 */

const OK = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const MISSING: CommandResult = { code: null, stdout: '', stderr: 'spawn ENOENT' };
const isServerProbe = (args: string[]) => args.includes('--format');

function runner(handle: (command: string, args: string[]) => CommandResult): CommandRunner {
    return {
        async run(command, args) {
            return handle(command, args);
        },
        stream(): StreamHandle {
            throw new Error('inspect never streams');
        },
    };
}

/** A machine where the given bins answer `--version`; docker is probed via the
 *  server format arg. `apt-get` present marks a Debian box. */
const machineWith = (present: string[]) =>
    runner((cmd, args) => {
        if (cmd === 'docker') return isServerProbe(args) && present.includes('docker') ? OK('27.3.1') : MISSING;
        return present.includes(cmd) ? OK('1.2.3\n') : MISSING;
    });

describe('inspectToolchain', () => {
    it('reports a fresh Debian box: everything missing, apt recommended, a full plan + consent', async () => {
        const insp = await inspectToolchain({ runner: machineWith(['apt-get']), os: 'linux' });

        expect(insp.report.missing).toEqual([...DEFAULT_TOOLCHAIN]);
        expect(insp.packageManagers.recommended).toBe('apt');
        expect(insp.pmChoice).toBe('apt');
        // A plan for every tool, git first and docker last.
        expect(insp.plan.map((s) => s.tool)[0]).toBe('git');
        expect(insp.plan.map((s) => s.tool).at(-1)).toBe('docker');
        expect(insp.consent.count).toBe(insp.plan.length);
        // apt installs need sudo, and docker always elevates.
        expect(insp.consent.requiresElevation).toBe(true);
    });

    it('plans nothing when the toolchain is already complete', async () => {
        const insp = await inspectToolchain({
            runner: machineWith([...DEFAULT_TOOLCHAIN.map((t) => (t === 'claude-code' ? 'claude' : t)), 'apt-get']),
            os: 'linux',
        });
        expect(insp.report.missing).toEqual([]);
        expect(insp.plan).toEqual([]);
        expect(insp.consent.count).toBe(0);
        expect(insp.consent.requiresElevation).toBe(false);
    });

    it('defaults pmChoice to direct on a Windows box without winget', async () => {
        const insp = await inspectToolchain({ runner: machineWith([]), os: 'win32' });
        expect(insp.packageManagers.recommended).toBeUndefined();
        expect(insp.pmChoice).toBe('direct');
        // With no manager, every install is a direct download (bar the npm TUIs).
        const systemTools = insp.plan.filter((s) => s.tool !== 'claude-code' && s.tool !== 'codex');
        expect(systemTools.every((s) => s.method === 'direct')).toBe(true);
    });

    it('honours an explicit pmChoice override', async () => {
        const insp = await inspectToolchain({
            runner: machineWith(['winget']),
            os: 'win32',
            pmChoice: 'direct',
        });
        expect(insp.pmChoice).toBe('direct');
        expect(insp.plan.find((s) => s.tool === 'git')?.method).toBe('direct');
    });

    it('uses the detected manager to plan when no override is given', async () => {
        const insp = await inspectToolchain({ runner: machineWith(['winget']), os: 'win32' });
        expect(insp.pmChoice).toBe('winget');
        expect(insp.plan.find((s) => s.tool === 'git')?.method).toBe('pm');
        expect(insp.plan.find((s) => s.tool === 'git')?.packageManager).toBe('winget');
    });

    it('narrows to a wanted subset', async () => {
        const insp = await inspectToolchain({
            runner: machineWith(['apt-get']),
            os: 'linux',
            wanted: ['git', 'node'],
        });
        expect(insp.report.probes.map((p) => p.name)).toEqual(['git', 'node']);
        expect(insp.plan.map((s) => s.tool)).toEqual(['git', 'node']);
    });

    it('carries the os through to BOTH the inspection and the detection report', async () => {
        const insp = await inspectToolchain({ runner: machineWith(['brew']), os: 'darwin' });
        expect(insp.os).toBe('darwin');
        // The report's platform must reflect the requested os, not the host's —
        // detectToolchain takes `platform`, and getting that wrong is silent.
        expect(insp.report.platform).toBe('darwin');
        expect(insp.packageManagers.recommended).toBe('brew');
    });
});
