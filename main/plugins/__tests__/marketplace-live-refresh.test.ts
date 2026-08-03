import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';
import { simpleGit } from 'simple-git';
import { initDatabase, deletePluginMarketplace, getPluginMarketplace, listPluginMarketplaces } from '../../db';
import {
    addMarketplace,
    marketplaceIndexIssues,
    marketplacePlugins,
    refreshMarketplace,
    refreshStaleMarketplaces,
} from '../install';

/**
 * "I published the plugin to the marketplace but Genie never showed it."
 *
 * A marketplace's member list is a CACHE of its `genie-marketplace.json`, read
 * once when the marketplace is added. This suite drives the whole chain against
 * a REAL git repo — add, publish a new plugin to the index, re-read — because
 * that is the only way to prove a newly published plugin actually reaches the
 * list. Two failures are pinned:
 *
 *   1. nothing re-read the index unless the user found the Refresh button, and
 *   2. one malformed sibling entry made the ENTIRE index unreadable, so every
 *      refresh failed identically and the cached list froze for good.
 */

const MARKETPLACE_ID = 'com.example.test-market';

let userData: string;
let repo: string;
let git: ReturnType<typeof simpleGit>;

/** The published index — `plugins` is whatever the marketplace currently lists. */
function publishIndex(plugins: unknown[]): Promise<unknown> {
    fs.writeFileSync(
        path.join(repo, 'genie-marketplace.json'),
        JSON.stringify({ id: MARKETPLACE_ID, name: 'Test Market', plugins }, null, 2),
    );
    return git.add('.').then(() => git.commit('publish'));
}

function member(id: string, name: string): Record<string, unknown> {
    return { id, name, repo: `https://example.invalid/${name}.git` };
}

beforeAll(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-market-'));
    initDatabase(userData);
    // Clones + the plugins cache land under userData.
    vi.spyOn(app, 'getPath').mockReturnValue(userData);

    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-market-repo-'));
    git = simpleGit(repo);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.email', 'genie-test@example.com');
    await git.addConfig('user.name', 'Genie Test');
    await publishIndex([member('com.example.alpha', 'Alpha')]);
});

afterAll(() => {
    vi.restoreAllMocks();
    for (const m of listPluginMarketplaces()) deletePluginMarketplace(m.id);
    for (const dir of [userData, repo]) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
    }
});

describe('a marketplace notices what has been published since it was added', () => {
    it('caches the index the marketplace listed when it was added', async () => {
        const summary = await addMarketplace(repo);
        expect(summary.id).toBe(MARKETPLACE_ID);
        expect(summary.pluginCount).toBe(1);
        expect(summary.rejected).toEqual([]);
        expect(marketplacePlugins(MARKETPLACE_ID).map((p) => p.id)).toEqual(['com.example.alpha']);
    });

    it('surfaces a NEWLY PUBLISHED plugin after the index is re-read', async () => {
        await publishIndex([member('com.example.alpha', 'Alpha'), member('com.example.repo-management', 'Repo Management')]);

        // Still the cached list — publishing alone changes nothing locally.
        expect(marketplacePlugins(MARKETPLACE_ID).map((p) => p.id)).toEqual(['com.example.alpha']);

        await refreshMarketplace(MARKETPLACE_ID);
        expect(marketplacePlugins(MARKETPLACE_ID).map((p) => p.id)).toEqual([
            'com.example.alpha',
            'com.example.repo-management',
        ]);
    });

    it('still lists the valid members when a sibling entry is malformed, and says which failed', async () => {
        await publishIndex([
            member('com.example.alpha', 'Alpha'),
            member('com.example.repo-management', 'Repo Management'),
            // Locatable by neither `repo` nor `path` — unusable, but its siblings
            // are fine and must stay visible.
            { id: 'com.example.broken', name: 'Broken' },
        ]);

        const summary = await refreshMarketplace(MARKETPLACE_ID);
        expect(summary.pluginCount).toBe(2);
        expect(marketplacePlugins(MARKETPLACE_ID).map((p) => p.id)).toEqual([
            'com.example.alpha',
            'com.example.repo-management',
        ]);

        const issues = marketplaceIndexIssues(MARKETPLACE_ID);
        expect(issues).toHaveLength(1);
        expect(issues[0].name).toBe('Broken');
        expect(issues[0].errors.join(' ')).toMatch(/repo|path/);
    });

    it('re-reads a stale index on demand and leaves a fresh one alone', async () => {
        await publishIndex([
            member('com.example.alpha', 'Alpha'),
            member('com.example.repo-management', 'Repo Management'),
            member('com.example.gamma', 'Gamma'),
        ]);

        // Fresh (just refreshed above) → a stale-only sweep does nothing.
        expect(await refreshStaleMarketplaces(60_000)).toEqual([]);
        expect(marketplacePlugins(MARKETPLACE_ID)).toHaveLength(2);

        // maxAge 0 is the explicit "check them all now".
        const reports = await refreshStaleMarketplaces(0);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({ id: MARKETPLACE_ID, ok: true });
        expect(marketplacePlugins(MARKETPLACE_ID).map((p) => p.id)).toContain('com.example.gamma');
    });

    it('reports an unreadable index instead of failing the whole sweep', async () => {
        fs.writeFileSync(path.join(repo, 'genie-marketplace.json'), '{ not json');
        await git.add('.').then(() => git.commit('break the index'));

        const reports = await refreshStaleMarketplaces(0);
        expect(reports).toHaveLength(1);
        expect(reports[0].ok).toBe(false);
        expect(reports[0].error).toMatch(/not valid JSON/);
        // The last good list survives a broken publish rather than blanking.
        expect(marketplacePlugins(MARKETPLACE_ID)).toHaveLength(3);
    });

    it('drops the stale row when the repo starts publishing a different index id', async () => {
        fs.writeFileSync(
            path.join(repo, 'genie-marketplace.json'),
            JSON.stringify({ id: 'com.example.renamed', name: 'Renamed Market', plugins: [member('com.example.alpha', 'Alpha')] }),
        );
        await git.add('.').then(() => git.commit('rename the index'));

        const summary = await refreshMarketplace(MARKETPLACE_ID);
        expect(summary.id).toBe('com.example.renamed');
        // Exactly one marketplace per URL — no undead copy still serving the old list.
        expect(getPluginMarketplace(MARKETPLACE_ID)).toBeNull();
        expect(listPluginMarketplaces().filter((m) => m.url === repo)).toHaveLength(1);
    });
});
