import { describe, expect, it } from 'vitest';
import type { HostToolName, HostToolProbe, ToolchainReport } from '../toolchain-detect';
import { DEFAULT_TOOLCHAIN } from '../toolchain-detect';
import { INSTALL_ORDER, planToolchainInstall, planToolUpdate } from '../toolchain-plan';

/**
 * The planner is the load-bearing pure decision in #240: given what a machine
 * HAS, it decides what to install, in what order, and how — with no shell and no
 * process, so every rule is asserted directly. The rules with teeth:
 *
 *   - never reinstall a present tool (don't clobber a user's own php/node);
 *   - order so dependencies come first — node before its `npm i -g` TUIs, php
 *     before composer, git early — and DOCKER LAST, because it is the one that
 *     wants elevation and a reboot;
 *   - carry the elevation/restart cost forward so consent can show it, never
 *     spring a UAC prompt or a required reboot by surprise.
 */

/** Build a detection report from the set of tools that ARE present. */
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

const NOTHING: HostToolName[] = [];
const toolsOf = (steps: { tool: HostToolName }[]) => steps.map((s) => s.tool);

describe('planToolchainInstall — what to install', () => {
    it('plans nothing when every tool is already present', () => {
        const steps = planToolchainInstall({
            detected: reportWith([...DEFAULT_TOOLCHAIN]),
            os: 'linux',
            pmChoice: 'apt',
        });
        expect(steps).toEqual([]);
    });

    it('never plans a present tool, even when others are missing', () => {
        const steps = planToolchainInstall({
            detected: reportWith(['git', 'node', 'npm', 'php', 'composer']),
            os: 'win32',
            pmChoice: 'winget',
        });
        // Only the agent TUIs and Docker were missing.
        expect(toolsOf(steps)).toEqual(['claude-code', 'codex', 'docker']);
    });

    it('plans the full toolchain on an empty machine, dependency-ordered', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'linux',
            pmChoice: 'apt',
        });
        expect(toolsOf(steps)).toEqual([...INSTALL_ORDER]);
    });
});

describe('planToolchainInstall — ordering', () => {
    it('installs git first', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'linux',
            pmChoice: 'apt',
        });
        expect(steps[0].tool).toBe('git');
    });

    it('installs node before the agent TUIs that need `npm i -g`', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'linux',
            pmChoice: 'apt',
        });
        const order = toolsOf(steps);
        expect(order.indexOf('node')).toBeLessThan(order.indexOf('claude-code'));
        expect(order.indexOf('npm')).toBeLessThan(order.indexOf('codex'));
    });

    it('installs php before composer', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'linux',
            pmChoice: 'apt',
        });
        const order = toolsOf(steps);
        expect(order.indexOf('php')).toBeLessThan(order.indexOf('composer'));
    });

    it('installs docker LAST no matter what order it was wanted in', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'win32',
            pmChoice: 'winget',
            wanted: ['docker', 'git', 'node'],
        });
        expect(toolsOf(steps)).toEqual(['git', 'node', 'docker']);
    });
});

describe('planToolchainInstall — method selection', () => {
    it('uses the chosen package manager for the tools it can install', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'win32',
            pmChoice: 'winget',
        });
        const git = steps.find((s) => s.tool === 'git')!;
        expect(git.method).toBe('pm');
        expect(git.packageManager).toBe('winget');
    });

    it('falls back to a direct download when the package manager cannot install a tool', () => {
        // winget has no first-class composer package — the direct installer is
        // the real path there.
        const steps = planToolchainInstall({
            detected: reportWith(['git', 'node', 'npm', 'php', 'docker', 'claude-code', 'codex']),
            os: 'win32',
            pmChoice: 'winget',
        });
        const composer = steps.find((s) => s.tool === 'composer')!;
        expect(composer.method).toBe('direct');
        expect(composer.packageManager).toBeUndefined();
    });

    it('installs everything direct when the user chose direct downloads', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'win32',
            pmChoice: 'direct',
        });
        for (const s of steps.filter((x) => x.tool !== 'claude-code' && x.tool !== 'codex')) {
            expect(s.method).toBe('direct');
        }
    });

    it('installs the agent TUIs via npm-global regardless of package-manager choice', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'darwin',
            pmChoice: 'brew',
        });
        for (const name of ['claude-code', 'codex'] as HostToolName[]) {
            const step = steps.find((s) => s.tool === name)!;
            expect(step.method).toBe('npm-global');
            expect(step.packageManager).toBeUndefined();
        }
    });

    it('lets a package manager that DOES ship composer use it (brew)', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'darwin',
            pmChoice: 'brew',
        });
        expect(steps.find((s) => s.tool === 'composer')!.method).toBe('pm');
    });
});

describe('planToolchainInstall — elevation and restart', () => {
    it('marks docker as needing elevation on every OS', () => {
        for (const os of ['win32', 'darwin', 'linux']) {
            const steps = planToolchainInstall({
                detected: reportWith([...DEFAULT_TOOLCHAIN].filter((t) => t !== 'docker')),
                os,
                pmChoice: 'direct',
            });
            expect(steps.find((s) => s.tool === 'docker')!.requiresElevation).toBe(true);
        }
    });

    it('marks docker on Windows as needing a restart (WSL2 + reboot), but not on mac/linux', () => {
        const only = (os: string) =>
            planToolchainInstall({
                detected: reportWith([...DEFAULT_TOOLCHAIN].filter((t) => t !== 'docker')),
                os,
                pmChoice: 'direct',
            }).find((s) => s.tool === 'docker')!;
        expect(only('win32').requiresRestart).toBe(true);
        expect(only('darwin').requiresRestart).toBe(false);
        expect(only('linux').requiresRestart).toBe(false);
    });

    it('needs elevation for a linux package-manager install (sudo apt/dnf)', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'linux',
            pmChoice: 'apt',
        });
        expect(steps.find((s) => s.tool === 'git')!.requiresElevation).toBe(true);
    });

    it('does NOT need elevation for a mac Homebrew install (user prefix)', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'darwin',
            pmChoice: 'brew',
        });
        expect(steps.find((s) => s.tool === 'git')!.requiresElevation).toBe(false);
    });

    it('never elevates an npm-global agent-TUI install', () => {
        const steps = planToolchainInstall({
            detected: reportWith(['git', 'node', 'npm', 'php', 'composer', 'docker']),
            os: 'linux',
            pmChoice: 'apt',
        });
        for (const name of ['claude-code', 'codex'] as HostToolName[]) {
            expect(steps.find((s) => s.tool === name)!.requiresElevation).toBe(false);
        }
    });
});

describe('planToolchainInstall — dependencies', () => {
    it('records the prerequisite each tool needs', () => {
        const steps = planToolchainInstall({
            detected: reportWith(NOTHING),
            os: 'linux',
            pmChoice: 'apt',
        });
        const dep = (tool: HostToolName) => steps.find((s) => s.tool === tool)!.dependsOn;
        expect(dep('npm')).toEqual(['node']);
        expect(dep('composer')).toEqual(['php']);
        expect(dep('claude-code')).toEqual(['npm']);
        expect(dep('codex')).toEqual(['npm']);
        expect(dep('git')).toEqual([]);
        expect(dep('docker')).toEqual([]);
    });
});

/**
 * The single-tool UPDATE step for the Toolchain Manager (#242 P2). Unlike an
 * install plan it targets a tool already present, so it never consults a
 * present-set — the method + cost are exactly what an install of that tool would
 * choose for this OS + package manager.
 */
describe('planToolUpdate', () => {
    it('uses the package manager on Windows when it can install the tool', () => {
        expect(planToolUpdate('git', 'win32', 'winget')).toMatchObject({
            tool: 'git',
            method: 'pm',
            packageManager: 'winget',
        });
    });

    it('routes an agent TUI through npm-global regardless of the PM choice', () => {
        expect(planToolUpdate('claude-code', 'darwin', 'brew')).toMatchObject({
            tool: 'claude-code',
            method: 'npm-global',
        });
    });

    it('carries docker its elevation + Windows reboot cost', () => {
        expect(planToolUpdate('docker', 'win32', 'winget')).toMatchObject({
            tool: 'docker',
            requiresElevation: true,
            requiresRestart: true,
        });
    });

    it('falls back to a direct download where the PM has no package (php on winget)', () => {
        expect(planToolUpdate('php', 'win32', 'winget')).toMatchObject({
            tool: 'php',
            method: 'direct',
        });
    });
});
