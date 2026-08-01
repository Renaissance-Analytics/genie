import { describe, expect, it } from 'vitest';
import {
    canOpenInBrowser,
    hostedSiteWorkspaces,
    railSitesTone,
    relativeDocroot,
    siteManagerRows,
    siteStatusLabel,
    siteStatusTone,
    runtimeSummary,
    type SiteManagerRow,
} from '../hosting';
import type { HostedSiteCandidate, HostedSiteRow, HostingRuntimeStatus } from '../genie';

/**
 * The Workspace Site Manager's view model (Tynn #232, hosting UX).
 *
 * The renderer test env is Node-only (no DOM), so the SURFACES are verified by
 * hand / e2e and everything they decide from lives here as pure functions: which
 * rows the manager shows (configured sites merged with the candidates Genie
 * detected), what each row's status reads as, whether "Open in Genie Browser" is
 * even meaningful yet, and which workspaces earn the sites icon in the rail.
 */

const row = (over: Partial<HostedSiteRow> = {}): HostedSiteRow => ({
    workspaceId: 'ws1',
    siteId: 'site-a',
    genName: 'tynn.gen',
    hostname: 'tynn.test',
    kind: 'php',
    docroot: 'repos/tynn/public',
    enabled: true,
    state: 'stopped',
    backend: null,
    origin: null,
    ...over,
});

const candidate = (over: Partial<HostedSiteCandidate> = {}): HostedSiteCandidate => ({
    project: 'repos/tynn',
    name: 'tynn',
    kind: 'php',
    docroot: 'repos/tynn/public',
    hostname: 'tynn.test',
    reason: 'PHP application — public/index.php',
    needsBuild: false,
    ...over,
});

describe('siteManagerRows', () => {
    it('lists a configured site', () => {
        const [r] = siteManagerRows([row()], []);
        expect(r).toMatchObject({
            hostname: 'tynn.test',
            configured: true,
            enabled: true,
            siteId: 'site-a',
        });
    });

    it('lists an unconfigured candidate, with the reason Genie proposes it', () => {
        const [r] = siteManagerRows([], [candidate()]);
        expect(r).toMatchObject({
            hostname: 'tynn.test',
            configured: false,
            enabled: false,
            state: 'stopped',
            reason: 'PHP application — public/index.php',
        });
        expect(r?.siteId).toBeUndefined();
    });

    it('does NOT re-offer a candidate that is already configured', () => {
        // Same hostname → one row, the configured one (it owns the real state).
        const rows = siteManagerRows([row()], [candidate()]);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.configured).toBe(true);
    });

    it('matches a configured site to its candidate by DOCROOT too', () => {
        // The user renamed the vhost; it is still the same directory, so
        // re-offering it as "new" would invite a second site on one docroot.
        const rows = siteManagerRows([row({ hostname: 'app.test' })], [candidate()]);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.hostname).toBe('app.test');
    });

    it('carries the candidate reason onto a configured row it matched', () => {
        const rows = siteManagerRows([row()], [candidate()]);
        expect(rows[0]?.reason).toBe('PHP application — public/index.php');
    });

    it('puts configured sites first, then the proposals', () => {
        const rows = siteManagerRows(
            [row({ hostname: 'b.test', docroot: 'repos/b/public' })],
            [candidate({ hostname: 'a.test', docroot: 'repos/a/dist', kind: 'static' })],
        );
        expect(rows.map((r) => r.hostname)).toEqual(['b.test', 'a.test']);
        expect(rows.map((r) => r.configured)).toEqual([true, false]);
    });

    it('gives every row a stable, unique key', () => {
        const rows = siteManagerRows(
            [row(), row({ siteId: 'site-b', hostname: 'b.test', docroot: 'repos/b/public' })],
            [candidate({ hostname: 'c.test', docroot: 'repos/c/dist' })],
        );
        const keys = rows.map((r) => r.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys.every(Boolean)).toBe(true);
    });

    it('is empty when a workspace has nothing configured and nothing detected', () => {
        expect(siteManagerRows([], [])).toEqual([]);
    });
});

describe('siteStatusLabel / siteStatusTone', () => {
    const asRow = (over: Partial<SiteManagerRow>): SiteManagerRow => ({
        key: 'k',
        name: 'tynn',
        hostname: 'tynn.test',
        genName: 'tynn.gen',
        kind: 'php',
        docroot: 'repos/tynn/public',
        configured: true,
        enabled: true,
        state: 'stopped',
        origin: null,
        ...over,
    });

    it('reads a running site as its URL', () => {
        const r = asRow({ state: 'running', origin: 'https://tynn.test:20431' });
        expect(siteStatusLabel(r)).toBe('https://tynn.test:20431');
        expect(siteStatusTone(r)).toBe('running');
    });

    it('reads a failure as its reason, not as "off"', () => {
        const r = asRow({ state: 'failed', error: 'no node_modules — run npm install' });
        expect(siteStatusLabel(r)).toBe('no node_modules — run npm install');
        expect(siteStatusTone(r)).toBe('failed');
    });

    it('distinguishes "not set up" from "set up but off"', () => {
        expect(siteStatusLabel(asRow({ configured: false, enabled: false }))).toBe(
            'Not hosted yet',
        );
        expect(siteStatusLabel(asRow({ enabled: false }))).toBe('Disabled');
        expect(siteStatusTone(asRow({ enabled: false }))).toBe('idle');
    });

    it('says a site is enabled but not up yet rather than claiming a URL', () => {
        const r = asRow({ enabled: true, state: 'stopped' });
        expect(siteStatusLabel(r)).toBe('Starting…');
        expect(siteStatusTone(r)).toBe('starting');
    });

    it('never shows a stale origin for a site that is not running', () => {
        const r = asRow({ state: 'failed', origin: 'https://tynn.test:20431', error: 'boom' });
        expect(siteStatusLabel(r)).toBe('boom');
    });
});

describe('canOpenInBrowser', () => {
    const asRow = (over: Partial<SiteManagerRow>): SiteManagerRow =>
        ({
            key: 'k',
            name: 'tynn',
            hostname: 'tynn.test',
            genName: 'tynn.gen',
            kind: 'php',
            docroot: 'd',
            configured: true,
            enabled: true,
            state: 'stopped',
            origin: null,
            ...over,
        }) as SiteManagerRow;

    it('is open-able only once the site is actually running', () => {
        expect(canOpenInBrowser(asRow({ state: 'running', origin: 'https://x:1' }))).toBe(true);
        expect(canOpenInBrowser(asRow({ state: 'stopped' }))).toBe(false);
        expect(canOpenInBrowser(asRow({ state: 'failed', error: 'x' }))).toBe(false);
        // Running but with no `.gen` name is not addressable in the browser.
        expect(canOpenInBrowser(asRow({ state: 'running', genName: '' }))).toBe(false);
    });
});

describe('hostedSiteWorkspaces (the rail icon)', () => {
    it('marks a workspace that has a site ENABLED', () => {
        const set = hostedSiteWorkspaces([row({ workspaceId: 'ws1', enabled: true })]);
        expect(set.has('ws1')).toBe(true);
    });

    it('does NOT mark a workspace whose sites are all disabled', () => {
        const set = hostedSiteWorkspaces([row({ workspaceId: 'ws1', enabled: false })]);
        expect(set.has('ws1')).toBe(false);
        expect(set.size).toBe(0);
    });

    it('marks each workspace once, across many sites', () => {
        const set = hostedSiteWorkspaces([
            row({ workspaceId: 'ws1', siteId: 'a', enabled: true }),
            row({ workspaceId: 'ws1', siteId: 'b', enabled: true }),
            row({ workspaceId: 'ws2', siteId: 'c', enabled: false }),
        ]);
        expect([...set]).toEqual(['ws1']);
    });

    it('is empty for no sites at all', () => {
        expect(hostedSiteWorkspaces([]).size).toBe(0);
    });
});

describe('railSitesTone', () => {
    it('is running when any of the workspace’s sites is up', () => {
        const rows = [
            row({ workspaceId: 'ws1', siteId: 'a', state: 'running' }),
            row({ workspaceId: 'ws1', siteId: 'b', state: 'stopped' }),
        ];
        expect(railSitesTone(rows, 'ws1')).toBe('running');
    });

    it('is failed when one is broken and none is up — a broken site must not read as idle', () => {
        const rows = [
            row({ workspaceId: 'ws1', siteId: 'a', state: 'failed', error: 'boom' }),
            row({ workspaceId: 'ws1', siteId: 'b', state: 'stopped' }),
        ];
        expect(railSitesTone(rows, 'ws1')).toBe('failed');
    });

    it('prefers "running" over "failed" — something is serving', () => {
        const rows = [
            row({ workspaceId: 'ws1', siteId: 'a', state: 'failed', error: 'boom' }),
            row({ workspaceId: 'ws1', siteId: 'b', state: 'running' }),
        ];
        expect(railSitesTone(rows, 'ws1')).toBe('running');
    });

    it('is idle for enabled-but-not-yet-started sites, and null when there are none', () => {
        expect(railSitesTone([row({ workspaceId: 'ws1' })], 'ws1')).toBe('idle');
        expect(railSitesTone([row({ workspaceId: 'ws1', enabled: false })], 'ws1')).toBeNull();
        expect(railSitesTone([], 'ws1')).toBeNull();
    });

    it('only counts THIS workspace’s sites', () => {
        const rows = [row({ workspaceId: 'ws2', state: 'running' })];
        expect(railSitesTone(rows, 'ws1')).toBeNull();
    });
});

describe('relativeDocroot', () => {
    it('relativises a directory picked inside the workspace', () => {
        expect(relativeDocroot('C:\\ws\\tynn.agi', 'C:\\ws\\tynn.agi\\repos\\tynn\\public')).toBe(
            'repos/tynn/public',
        );
        expect(relativeDocroot('/ws/app', '/ws/app/dist')).toBe('dist');
    });

    it('reads the workspace root itself as the empty docroot', () => {
        expect(relativeDocroot('/ws/app', '/ws/app')).toBe('');
        expect(relativeDocroot('/ws/app/', '/ws/app')).toBe('');
    });

    it('REFUSES a directory outside the workspace — that would publish it', () => {
        expect(relativeDocroot('/ws/app', '/etc')).toBeNull();
        expect(relativeDocroot('/ws/app', '/ws/app-other/dist')).toBeNull();
        expect(relativeDocroot('/ws/app', '/ws')).toBeNull();
    });

    it('is case-insensitive about the workspace prefix (one Windows directory)', () => {
        expect(relativeDocroot('C:\\Dev\\ws', 'c:\\dev\\ws\\public')).toBe('public');
    });

    it('is null for a missing path rather than guessing', () => {
        expect(relativeDocroot('', '/ws/app/dist')).toBeNull();
        expect(relativeDocroot('/ws/app', '')).toBeNull();
    });
});

describe('runtimeSummary', () => {
    const status = (over: Partial<HostingRuntimeStatus> = {}): HostingRuntimeStatus => ({
        version: 'v1.12.6',
        installDir: '/data/hosting/frankenphp/v1.12.6',
        binaryPath: '/data/hosting/frankenphp/v1.12.6/frankenphp',
        extensionDir: null,
        installed: false,
        supported: true,
        assetName: 'frankenphp-linux-x86_64',
        platform: 'linux',
        arch: 'x64',
        ...over,
    });

    it('offers the download when the runtime is missing but possible', () => {
        const s = runtimeSummary(status());
        expect(s).toMatchObject({ tone: 'idle', installable: true });
        expect(s.label).toMatch(/not installed/i);
    });

    it('confirms the installed version', () => {
        const s = runtimeSummary(status({ installed: true }));
        expect(s).toMatchObject({ tone: 'running', installable: false });
        expect(s.label).toContain('v1.12.6');
    });

    it('says PHP hosting is impossible here rather than offering a doomed download', () => {
        const s = runtimeSummary(status({ supported: false, assetName: null }));
        expect(s).toMatchObject({ tone: 'failed', installable: false });
        expect(s.label).toMatch(/no FrankenPHP build/i);
    });

    it('tolerates never having read the status', () => {
        const s = runtimeSummary(null);
        expect(s).toMatchObject({ tone: 'idle', installable: false });
    });
});
