import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnabledGenSite } from '../../remote';

/**
 * How HOSTED sites reach the Testing Browser (Tynn #232, P2).
 *
 * `listLocalEnabledGenSites()` has always answered one question — "which `.gen`
 * sites can this machine serve right now?" — from ONE source: the OS hosts file
 * plus a loopback probe. That source can only ever describe sites something
 * ELSE is serving (Herd, `artisan serve`, `npm run dev`), which is precisely why
 * remote preview kept breaking.
 *
 * P2 adds a second source: sites GENIE serves. The join is deliberately a
 * shallow overlay rather than a new resolution path, because everything
 * downstream (`localTargetsBySiteId` → the local carrier → the site shim) reads
 * the same `EnabledGenSite` rows it always did. So there are exactly two things
 * to get right, and both are tested here:
 *
 *   1. hosted sites are EMITTED at all, and
 *   2. when a hostname is both discovered and hosted, the HOSTED target wins.
 */

/** A discovered `SiteView` as `discoverSites` would return it. */
interface FakeSiteView {
    enabled: boolean;
    genName: string;
    siteId: string;
    hostname: string;
    scheme: 'http' | 'https';
    port: number;
}

const hostedGenSites = vi.fn((): EnabledGenSite[] => []);
const devServerGenSites = vi.fn((): EnabledGenSite[] => []);
const discoverSites = vi.fn(async (): Promise<FakeSiteView[]> => []);
const listWorkspaces = vi.fn((): Array<{ id: string }> => [{ id: 'ws1' }]);
const getWorkspaceTunnelSites = vi.fn(
    (_workspaceId: string): Record<string, { enabled: boolean }> => ({ site: { enabled: true } }),
);

vi.mock('../../hosting/manager', () => ({ hostedGenSites: () => hostedGenSites() }));
vi.mock('../../dev-server/site-manager', () => ({
    devServerGenSites: () => devServerGenSites(),
}));
vi.mock('../../mobile/hosts', () => ({ discoverSites: () => discoverSites() }));
vi.mock('../../db', () => ({
    listWorkspaces: () => listWorkspaces(),
    getWorkspaceTunnelSites: (id: string) => getWorkspaceTunnelSites(id),
}));

// eslint-disable-next-line import/first -- `vi.mock` is hoisted above this.
import { listLocalEnabledGenSites, localTargetsBySiteId, mergeHostedSites } from '../local-sites';

/** A hosts-file-discovered Herd site on 443. */
const DISCOVERED: EnabledGenSite = {
    workspaceId: 'ws1',
    genName: 'tynn.gen',
    siteId: 'id-tynn',
    hostname: 'tynn.test',
    scheme: 'https',
    port: 443,
};

/** The SAME site, served by Genie on a port it chose. */
const HOSTED: EnabledGenSite = {
    workspaceId: 'ws1',
    genName: 'tynn.gen',
    siteId: 'id-tynn',
    hostname: 'tynn.test',
    scheme: 'https',
    port: 20_431,
    loopback: '127.0.0.1',
};

/** A dev site the container Dev Server (#234 P2) is serving right now — the
 *  `port` is the runtime's PUBLISHED loopback port for the container. */
const CONTAINER: EnabledGenSite = {
    workspaceId: 'ws1',
    genName: 'web.acme.gen',
    siteId: 'id-web',
    hostname: 'web.acme.gen',
    scheme: 'http',
    port: 49_812,
    loopback: '127.0.0.1',
};

beforeEach(() => {
    vi.clearAllMocks();
    hostedGenSites.mockReturnValue([]);
    devServerGenSites.mockReturnValue([]);
    listWorkspaces.mockReturnValue([{ id: 'ws1' }]);
    getWorkspaceTunnelSites.mockReturnValue({ site: { enabled: true } });
    discoverSites.mockResolvedValue([]);
});

// --- the pure overlay ------------------------------------------------------

describe('mergeHostedSites', () => {
    it('leaves discovery alone when nothing is hosted', () => {
        expect(mergeHostedSites([DISCOVERED], [])).toEqual([DISCOVERED]);
    });

    it('adds a hosted site that discovery never saw', () => {
        // A hosted site needs no hosts-file entry at all — Genie is the server,
        // so there is nothing for the OS to resolve.
        const other = { ...HOSTED, siteId: 'id-fancy', hostname: 'fancy.test', genName: 'fancy.gen' };
        expect(mergeHostedSites([DISCOVERED], [other])).toEqual([DISCOVERED, other]);
    });

    it('PREFERS the hosted target when a hostname is both discovered and hosted', () => {
        // The one assertion the whole feature rests on: with Herd also serving
        // tynn.test on 443, the Testing Browser must dial the port GENIE is
        // serving, because that is the built, same-origin one.
        const merged = mergeHostedSites([DISCOVERED], [HOSTED]);
        expect(merged).toHaveLength(1);
        expect(merged[0]?.port).toBe(20_431);
        expect(localTargetsBySiteId(merged).get('id-tynn')).toEqual({
            scheme: 'https',
            hostname: 'tynn.test',
            port: 20_431,
            loopback: '127.0.0.1',
        });
    });

    it('replaces the discovered entry even when its `.gen` name was overridden', () => {
        // A workspace can rename a discovered site's `.gen`. Matching only on
        // genName would then leave BOTH entries with the same siteId, and
        // `localTargetsBySiteId` would resolve whichever happened to be last.
        const renamed = { ...DISCOVERED, genName: 'legacy.gen' };
        const merged = mergeHostedSites([renamed], [HOSTED]);
        expect(merged).toEqual([HOSTED]);
    });

    it('replaces a DIFFERENT site squatting the same `.gen` name', () => {
        // Two hostnames can be pointed at one `.gen`. The hosted one owns it —
        // otherwise the browser navigates to a name that resolves to a target
        // Genie is not serving.
        const squatter = { ...DISCOVERED, siteId: 'id-other', hostname: 'other.test' };
        expect(mergeHostedSites([squatter], [HOSTED])).toEqual([HOSTED]);
    });

    it('keeps the position of the entry it replaced', () => {
        const first = { ...DISCOVERED, siteId: 'id-a', hostname: 'a.test', genName: 'a.gen' };
        const last = { ...DISCOVERED, siteId: 'id-z', hostname: 'z.test', genName: 'z.gen' };
        const merged = mergeHostedSites([first, DISCOVERED, last], [HOSTED]);
        expect(merged.map((s) => s.genName)).toEqual(['a.gen', 'tynn.gen', 'z.gen']);
        expect(merged[1]?.port).toBe(20_431);
    });
});

// --- the emit --------------------------------------------------------------

describe('listLocalEnabledGenSites', () => {
    it('EMITS hosted sites, not just discovered ones', async () => {
        // Without this the pure overlay above is dead code: nothing would ever
        // hand it a hosted row.
        hostedGenSites.mockReturnValue([HOSTED]);
        const sites = await listLocalEnabledGenSites();
        expect(sites).toEqual([HOSTED]);
    });

    it('prefers the hosted target over the discovered one, end to end', async () => {
        discoverSites.mockResolvedValue([
            {
                enabled: true,
                genName: 'tynn.gen',
                siteId: 'id-tynn',
                hostname: 'tynn.test',
                scheme: 'https',
                port: 443,
            },
        ]);
        hostedGenSites.mockReturnValue([HOSTED]);
        const targets = localTargetsBySiteId(await listLocalEnabledGenSites());
        expect(targets.get('id-tynn')?.port).toBe(20_431);
    });

    it('still returns discovered sites when nothing is hosted', async () => {
        // The additive guarantee: a user with no hosted sites sees exactly what
        // they saw before.
        discoverSites.mockResolvedValue([
            {
                enabled: true,
                genName: 'tynn.gen',
                siteId: 'id-tynn',
                hostname: 'tynn.test',
                scheme: 'https',
                port: 443,
            },
        ]);
        const sites = await listLocalEnabledGenSites();
        expect(sites).toHaveLength(1);
        expect(sites[0]?.port).toBe(443);
    });

    it('emits hosted sites even when discovery throws', async () => {
        // An unreadable hosts file must not hide sites Genie is serving itself.
        discoverSites.mockRejectedValue(new Error('hosts file unreadable'));
        hostedGenSites.mockReturnValue([HOSTED]);
        expect(await listLocalEnabledGenSites()).toEqual([HOSTED]);
    });

    // --- the container Dev Server (#234 P2) --------------------------------

    it('EMITS a container dev site, so `<name>.gen` resolves to its published port', async () => {
        // THE P2 ROUTING SEAM. A dev server running in the workspace sandbox
        // reaches the Testing Browser as an ordinary `EnabledGenSite` whose
        // target is the container's published loopback port — no proxy, no new
        // resolution path, and identical for a local and a remote viewer (the
        // remote reads this same aggregation over `/api/sites/enabled`).
        devServerGenSites.mockReturnValue([CONTAINER]);
        const targets = localTargetsBySiteId(await listLocalEnabledGenSites());
        expect(targets.get('id-web')).toEqual({
            scheme: 'http',
            hostname: 'web.acme.gen',
            port: 49_812,
            loopback: '127.0.0.1',
        });
    });

    it('lets a RUNNING container win over a native-hosted site of the same name', async () => {
        // Both sources are overlaid; the dev server is applied last, so during
        // the P4 migration a workspace that has moved a site to a container gets
        // the container, not the retired FrankenPHP port.
        const sameName = { ...HOSTED, siteId: 'id-web', genName: 'web.acme.gen' };
        devServerGenSites.mockReturnValue([CONTAINER]);
        hostedGenSites.mockReturnValue([sameName]);
        const sites = await listLocalEnabledGenSites();
        expect(sites).toHaveLength(1);
        expect(sites[0]?.port).toBe(49_812);
    });

    it('carries hosted and container sites side by side', async () => {
        devServerGenSites.mockReturnValue([CONTAINER]);
        hostedGenSites.mockReturnValue([HOSTED]);
        const sites = await listLocalEnabledGenSites();
        expect(sites.map((s) => s.genName).sort()).toEqual(['tynn.gen', 'web.acme.gen']);
    });
});
