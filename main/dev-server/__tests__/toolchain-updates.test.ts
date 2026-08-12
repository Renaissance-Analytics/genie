import { describe, expect, it, vi } from 'vitest';
import type { HostToolName, ToolchainReport, HostToolProbe } from '../toolchain-detect';
import {
    compareVersions,
    detectToolUpdates,
    isUpdateAvailable,
} from '../toolchain-updates';

/**
 * The Workstation Toolchain & Engine Manager (story #242) answers "is there a
 * newer version of what I have installed?" The DECISION — is `latest` actually
 * newer than `installed`, and folding that across everything present — is pure,
 * so it is tested directly; WHERE `latest` comes from (a package manager's
 * outdated list, a version index, a registry) is the injected seam, built after.
 * Contract mirrors detection: a source that fails is "no update known", never a
 * throw.
 */

function reportWith(present: Partial<Record<HostToolName, string>>): ToolchainReport {
    const probes: HostToolProbe[] = (Object.keys(present) as HostToolName[]).map((name) => ({
        name,
        installed: true,
        ...(present[name] ? { version: present[name] } : {}),
    }));
    const names = probes.map((p) => p.name);
    return { platform: 'linux', probes, present: names, missing: [] };
}

describe('compareVersions', () => {
    it('orders equal / older / newer', () => {
        expect(compareVersions('2.42.0', '2.42.0')).toBe(0);
        expect(compareVersions('2.42.0', '2.42.1')).toBe(-1);
        expect(compareVersions('2.43.0', '2.42.9')).toBe(1);
    });

    it('compares numerically, not lexically (11 > 9)', () => {
        expect(compareVersions('20.11.0', '20.9.0')).toBe(1);
    });

    it('ignores a leading v and surrounding prose', () => {
        expect(compareVersions('v20.11.0', '20.11.0')).toBe(0);
        expect(compareVersions('PHP 8.3.2', '8.3.1')).toBe(1);
    });

    it('treats a missing trailing segment as zero (8.3 == 8.3.0 < 8.3.2)', () => {
        expect(compareVersions('8.3', '8.3.0')).toBe(0);
        expect(compareVersions('8.3', '8.3.2')).toBe(-1);
    });

    it('sorts an unparseable version below a real one', () => {
        expect(compareVersions('', '1.0.0')).toBe(-1);
        expect(compareVersions('unknown', '1.0.0')).toBe(-1);
    });
});

describe('isUpdateAvailable', () => {
    it('is true only when latest is strictly newer than installed', () => {
        expect(isUpdateAvailable('2.42.0', '2.43.0')).toBe(true);
        expect(isUpdateAvailable('2.43.0', '2.42.0')).toBe(false);
        expect(isUpdateAvailable('2.42.0', '2.42.0')).toBe(false);
    });

    it('is false when either version is unknown — never guess an update', () => {
        expect(isUpdateAvailable(undefined, '2.0.0')).toBe(false);
        expect(isUpdateAvailable('2.0.0', undefined)).toBe(false);
        expect(isUpdateAvailable(undefined, undefined)).toBe(false);
    });
});

describe('detectToolUpdates', () => {
    it('flags an update when the source reports a newer version', async () => {
        const report = reportWith({ git: '2.42.0', node: '20.11.0' });
        const latestFor = vi.fn(async (tool: HostToolName) =>
            tool === 'git'
                ? { version: '2.45.0', source: 'package-manager' as const }
                : { version: '20.11.0', source: 'version-index' as const },
        );
        const updates = await detectToolUpdates(report, latestFor);
        const byName = Object.fromEntries(updates.map((u) => [u.name, u]));
        expect(byName.git).toMatchObject({
            installed: '2.42.0',
            latest: '2.45.0',
            updateAvailable: true,
            source: 'package-manager',
        });
        expect(byName.node).toMatchObject({ updateAvailable: false, source: 'version-index' });
    });

    it('only reports tools that are actually installed', async () => {
        const report: ToolchainReport = {
            platform: 'linux',
            probes: [
                { name: 'git', installed: true, version: '2.42.0' },
                { name: 'docker', installed: false },
            ],
            present: ['git'],
            missing: ['docker'],
        };
        const updates = await detectToolUpdates(report, async () => null);
        expect(updates.map((u) => u.name)).toEqual(['git']);
    });

    it('records no update (source unknown) when the source has no answer', async () => {
        const report = reportWith({ composer: '2.6.5' });
        const updates = await detectToolUpdates(report, async () => null);
        expect(updates[0]).toMatchObject({
            name: 'composer',
            installed: '2.6.5',
            updateAvailable: false,
            source: 'unknown',
        });
        expect(updates[0].latest).toBeUndefined();
    });

    it('never throws when a source rejects — that tool just has no known update', async () => {
        const report = reportWith({ git: '2.42.0' });
        const updates = await detectToolUpdates(report, async () => {
            throw new Error('registry down');
        });
        expect(updates[0]).toMatchObject({ name: 'git', updateAvailable: false });
    });

    it('passes the installed version to the source (so it can short-circuit)', async () => {
        const report = reportWith({ node: '20.11.0' });
        const latestFor = vi.fn(async () => null);
        await detectToolUpdates(report, latestFor);
        expect(latestFor).toHaveBeenCalledWith('node', '20.11.0');
    });
});
