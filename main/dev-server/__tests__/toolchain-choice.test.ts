import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner, StreamHandle } from '../container-runtime';
import type { HostToolName, ToolchainReport, HostToolProbe } from '../toolchain-detect';
import { DEFAULT_TOOLCHAIN } from '../toolchain-detect';
import { planToolchainInstall } from '../toolchain-plan';
import { availablePackageManagers, summarizeInstallPlan } from '../toolchain-choice';

/**
 * Phase 3 (#684) is the CHOICE + CONSENT layer, and both halves are pure so the
 * UI is a thin render over them:
 *
 *   - `availablePackageManagers` asks the machine which managers actually exist
 *     and names the one to preselect — never offering brew on Windows, and
 *     always leaving `direct` as the floor so a machine with no manager (a
 *     winget-less Windows) still has a path.
 *   - `summarizeInstallPlan` folds a plan into the reviewable object a user says
 *     yes to BEFORE anything runs — what installs, how, and every elevation /
 *     reboot cost surfaced rather than sprung.
 */

const OK = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const MISSING: CommandResult = { code: null, stdout: '', stderr: 'spawn ENOENT' };

function runner(handle: (command: string, args: string[]) => CommandResult): CommandRunner {
    return {
        async run(command, args) {
            return handle(command, args);
        },
        stream(): StreamHandle {
            throw new Error('choice never streams');
        },
    };
}

/** The bin each manager answers to — `apt` is `apt-get` on the command line. */
const PM_BIN: Record<string, string> = { winget: 'winget', brew: 'brew', apt: 'apt-get', dnf: 'dnf' };
const present = (...bins: string[]) =>
    runner((cmd) => (bins.includes(cmd) ? OK('1.2.3\n') : MISSING));

describe('availablePackageManagers', () => {
    it('finds winget on Windows and recommends it', async () => {
        const r = await availablePackageManagers({ os: 'win32', runner: present(PM_BIN.winget) });
        expect(r.available).toEqual(['winget']);
        expect(r.recommended).toBe('winget');
        expect(r.defaultChoice).toBe('winget');
    });

    it('falls back to direct on a Windows machine WITHOUT winget', async () => {
        const r = await availablePackageManagers({ os: 'win32', runner: present() });
        expect(r.available).toEqual([]);
        expect(r.recommended).toBeUndefined();
        expect(r.defaultChoice).toBe('direct');
    });

    it('recommends brew on macOS', async () => {
        const r = await availablePackageManagers({ os: 'darwin', runner: present(PM_BIN.brew) });
        expect(r.recommended).toBe('brew');
    });

    it('recommends apt when only apt is present on Linux', async () => {
        const r = await availablePackageManagers({ os: 'linux', runner: present(PM_BIN.apt) });
        expect(r.available).toEqual(['apt']);
        expect(r.recommended).toBe('apt');
    });

    it('recommends dnf when only dnf is present on Linux', async () => {
        const r = await availablePackageManagers({ os: 'linux', runner: present(PM_BIN.dnf) });
        expect(r.available).toEqual(['dnf']);
        expect(r.recommended).toBe('dnf');
    });

    it('prefers apt when a Linux box somehow has both', async () => {
        const r = await availablePackageManagers({ os: 'linux', runner: present(PM_BIN.apt, PM_BIN.dnf) });
        expect(r.available).toEqual(['apt', 'dnf']);
        expect(r.recommended).toBe('apt');
    });

    it('offers only direct when Linux has no supported manager', async () => {
        const r = await availablePackageManagers({ os: 'linux', runner: present() });
        expect(r.defaultChoice).toBe('direct');
    });

    it('never probes a manager that does not belong to this OS', async () => {
        const asked: string[] = [];
        await availablePackageManagers({
            os: 'win32',
            runner: runner((cmd) => {
                asked.push(cmd);
                return MISSING;
            }),
        });
        expect(asked).toEqual(['winget']);
        expect(asked).not.toContain('brew');
        expect(asked).not.toContain('apt-get');
    });

    it('records the manager version for the picker', async () => {
        const r = await availablePackageManagers({
            os: 'darwin',
            runner: runner((cmd) => (cmd === 'brew' ? OK('Homebrew 4.2.0\n') : MISSING)),
        });
        expect(r.probes.find((p) => p.pm === 'brew')?.version).toBe('4.2.0');
    });

    it('offers direct on an unknown platform, probing nothing', async () => {
        const asked: string[] = [];
        const r = await availablePackageManagers({
            os: 'aix',
            runner: runner((cmd) => {
                asked.push(cmd);
                return OK('x');
            }),
        });
        expect(r.available).toEqual([]);
        expect(r.defaultChoice).toBe('direct');
        expect(asked).toEqual([]);
    });

    it('never throws when the runner rejects', async () => {
        const r = await availablePackageManagers({
            os: 'linux',
            runner: {
                run: () => Promise.reject(new Error('boom')),
                stream: () => {
                    throw new Error('unused');
                },
            },
        });
        expect(r.defaultChoice).toBe('direct');
    });

    it('honours a bin override for a non-PATH manager', async () => {
        const asked: string[] = [];
        await availablePackageManagers({
            os: 'linux',
            runner: runner((cmd) => {
                asked.push(cmd);
                return MISSING;
            }),
            binFor: (pm) => (pm === 'apt' ? '/usr/bin/apt-get' : PM_BIN[pm]),
        });
        expect(asked).toContain('/usr/bin/apt-get');
    });
});

// --- consent ---------------------------------------------------------------

function reportWith(present: HostToolName[], platform = 'linux'): ToolchainReport {
    const presentSet = new Set(present);
    const probes: HostToolProbe[] = DEFAULT_TOOLCHAIN.map((name) => ({
        name,
        installed: presentSet.has(name),
    }));
    return {
        platform,
        probes,
        present: DEFAULT_TOOLCHAIN.filter((n) => presentSet.has(n)),
        missing: DEFAULT_TOOLCHAIN.filter((n) => !presentSet.has(n)),
    };
}

describe('summarizeInstallPlan', () => {
    it('summarises an empty plan as nothing to do, no cost', () => {
        const summary = summarizeInstallPlan([]);
        expect(summary.count).toBe(0);
        expect(summary.installs).toEqual([]);
        expect(summary.requiresElevation).toBe(false);
        expect(summary.requiresRestart).toBe(false);
    });

    it('lists every install in plan order with its method', () => {
        const steps = planToolchainInstall({
            detected: reportWith([]),
            os: 'linux',
            pmChoice: 'apt',
        });
        const summary = summarizeInstallPlan(steps);
        expect(summary.count).toBe(steps.length);
        expect(summary.installs.map((l) => l.tool)).toEqual(steps.map((s) => s.tool));
        const git = summary.installs.find((l) => l.tool === 'git')!;
        expect(git.method).toBe('pm');
        expect(git.packageManager).toBe('apt');
    });

    it('raises the elevation flag and names which tools need it', () => {
        const steps = planToolchainInstall({
            detected: reportWith([]),
            os: 'linux',
            pmChoice: 'apt',
        });
        const summary = summarizeInstallPlan(steps);
        expect(summary.requiresElevation).toBe(true);
        // Every linux apt install needs sudo, and docker always does.
        expect(summary.elevated).toContain('docker');
        expect(summary.elevated).toContain('git');
    });

    it('raises the restart flag only for Windows Docker and names it', () => {
        const win = summarizeInstallPlan(
            planToolchainInstall({
                detected: reportWith([...DEFAULT_TOOLCHAIN].filter((t) => t !== 'docker')),
                os: 'win32',
                pmChoice: 'winget',
            }),
        );
        expect(win.requiresRestart).toBe(true);
        expect(win.restarts).toEqual(['docker']);

        const mac = summarizeInstallPlan(
            planToolchainInstall({
                detected: reportWith([...DEFAULT_TOOLCHAIN].filter((t) => t !== 'docker')),
                os: 'darwin',
                pmChoice: 'brew',
            }),
        );
        expect(mac.requiresRestart).toBe(false);
        expect(mac.restarts).toEqual([]);
    });

    it('does not flag elevation when nothing in the plan needs it', () => {
        // node present → only the npm-global TUIs remain, which never elevate.
        const steps = planToolchainInstall({
            detected: reportWith(['git', 'node', 'npm', 'php', 'composer', 'docker']),
            os: 'linux',
            pmChoice: 'apt',
        });
        const summary = summarizeInstallPlan(steps);
        expect(summary.installs.map((l) => l.tool)).toEqual(['claude-code', 'codex']);
        expect(summary.requiresElevation).toBe(false);
        expect(summary.elevated).toEqual([]);
    });
});
