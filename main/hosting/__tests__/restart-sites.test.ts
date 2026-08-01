import { describe, expect, it } from 'vitest';
import { restartSitesForWorkspace, type RestartableHosting } from '../restart-sites';
import type { HostedSiteRow } from '../manager';

/**
 * Restarting a workspace's hosted sites after its SERVICES changed (#232, the
 * seam between P2's sites and P3's services).
 *
 * A hosted site is handed its database credentials as ENVIRONMENT, and a process
 * reads its environment exactly once — at start. So a site that was already
 * running when the user enabled Postgres is serving an app with no `DB_*` at
 * all: a 500 on the first query, with nothing on screen to connect it to the
 * switch that was just flipped. Turning a database on has to restart the sites
 * that will use it.
 */

const row = (over: Partial<HostedSiteRow> = {}): HostedSiteRow =>
    ({
        workspaceId: 'ws1',
        siteId: 'site-a',
        hostname: 'shop.test',
        genName: 'shop.gen',
        kind: 'php',
        docroot: 'public',
        enabled: true,
        state: 'running',
        backend: 'frankenphp',
        origin: 'https://shop.test:20431',
        ...over,
    }) as HostedSiteRow;

function fakeHosting(rows: HostedSiteRow[]): RestartableHosting & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        list: (workspaceId?: string) =>
            rows.filter((r) => !workspaceId || r.workspaceId === workspaceId),
        stop: async (siteId) => {
            calls.push(`stop:${siteId}`);
        },
        start: async (workspaceId, hostname) => {
            calls.push(`start:${workspaceId}:${hostname}`);
            return { siteId: 'x', state: 'running', backend: 'frankenphp', target: null, origin: null };
        },
    };
}

describe('restartSitesForWorkspace', () => {
    it('stops then starts each RUNNING site, so it re-reads the service env', async () => {
        const hosting = fakeHosting([row()]);
        expect(await restartSitesForWorkspace(hosting, 'ws1')).toBe(1);
        expect(hosting.calls).toEqual(['stop:site-a', 'start:ws1:shop.test']);
    });

    it('leaves a site that is not running alone — starting it is the user’s call', async () => {
        const hosting = fakeHosting([
            row({ state: 'stopped' }),
            row({ siteId: 'site-b', hostname: 'b.test', state: 'failed' }),
        ]);
        expect(await restartSitesForWorkspace(hosting, 'ws1')).toBe(0);
        expect(hosting.calls).toEqual([]);
    });

    it('never touches ANOTHER workspace’s sites', async () => {
        const hosting = fakeHosting([
            row(),
            row({ workspaceId: 'ws2', siteId: 'site-c', hostname: 'other.test' }),
        ]);
        await restartSitesForWorkspace(hosting, 'ws1');
        expect(hosting.calls).toEqual(['stop:site-a', 'start:ws1:shop.test']);
    });

    it('tolerates no hosting manager at all (a headless host)', async () => {
        expect(await restartSitesForWorkspace(null, 'ws1')).toBe(0);
    });

    it('keeps going when one site fails to come back, and still reports the rest', async () => {
        const hosting = fakeHosting([
            row(),
            row({ siteId: 'site-b', hostname: 'b.test' }),
        ]);
        const broken: RestartableHosting = {
            ...hosting,
            start: async (workspaceId, hostname) => {
                hosting.calls.push(`start:${workspaceId}:${hostname}`);
                if (hostname === 'shop.test') throw new Error('runtime gone');
                return { siteId: 'x', state: 'running', backend: 'frankenphp', target: null, origin: null };
            },
        };
        expect(await restartSitesForWorkspace(broken, 'ws1')).toBe(1);
        expect(hosting.calls).toContain('start:ws1:b.test');
    });
});
