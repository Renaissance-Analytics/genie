import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppInboxKeys } from '../src/main/app-inbox-keys.js';

/**
 * THE APP KEYS (genie#1345). The credential IS the identity: Genie mints one per site and per kept process (handed only
 * to that one's own environment), and the person creates named keys for scripts outside Genie (the owner's D3: "shown
 * once, can be revoked, are limited to one workspace, and show in Settings"). Nothing on disk can be replayed: a
 * source's token lives in memory for this run, and a script key is kept only as its hash.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-app-keys-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const site = { kind: 'site' as const, id: 'site_flabs', name: 'flabs', workspaceId: 'fancy' };
const proc = { kind: 'process' as const, id: 'proc_1', name: 'queue', workspaceId: 'fancy' };

async function everythingOnDisk(): Promise<string> {
    const walk = async (d: string): Promise<string[]> => {
        const out: string[] = [];
        for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) out.push(...(await walk(p)));
            else out.push(await readFile(p, 'utf8'));
        }
        return out;
    };
    return (await walk(dir)).join('\n');
}

describe('a source’s token', () => {
    it('resolves to exactly that source, and is stable for the run', async () => {
        const keys = await AppInboxKeys.open(dir);
        const t = keys.tokenFor(site)!;
        expect(t).toMatch(/^gik_[A-Za-z0-9_-]{40,}$/);
        expect(keys.tokenFor(site)).toBe(t);
        expect(keys.resolve(t)).toEqual(site);
        const p = keys.tokenFor(proc)!;
        expect(p).not.toBe(t);
        expect(keys.resolve(p)).toEqual(proc);
    });

    it('an unknown, empty or near-miss token resolves to nobody', async () => {
        const keys = await AppInboxKeys.open(dir);
        const t = keys.tokenFor(site)!;
        expect(keys.resolve('')).toBeNull();
        expect(keys.resolve('gik_nope')).toBeNull();
        expect(keys.resolve(`${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
        expect(keys.resolve(t)).not.toBeNull(); // positive control
    });

    it('is never written to disk, and a new run mints a new one (the old one is dead)', async () => {
        const keys = await AppInboxKeys.open(dir);
        const t = keys.tokenFor(site)!;
        await keys.revokeSource({ kind: 'process', id: 'proc_other', workspaceId: 'fancy' }); // forces a write of the book
        expect(await everythingOnDisk()).not.toContain(t);
        const next = await AppInboxKeys.open(dir);
        expect(next.resolve(t)).toBeNull();
        expect(next.tokenFor(site)).not.toBe(t);
    });

    it('Rotate: a new token, the old one dead at once', async () => {
        const keys = await AppInboxKeys.open(dir);
        const t = keys.tokenFor(site)!;
        keys.rotate('site', 'site_flabs');
        expect(keys.resolve(t)).toBeNull();
        const t2 = keys.tokenFor(site)!;
        expect(t2).not.toBe(t);
        expect(keys.resolve(t2)).toEqual(site);
    });

    it('Revoke: dead at once, no token on the next start, and it survives a restart; Allow brings it back', async () => {
        const keys = await AppInboxKeys.open(dir);
        const t = keys.tokenFor(site)!;
        await keys.revokeSource(site);
        expect(keys.resolve(t)).toBeNull();
        expect(keys.tokenFor(site)).toBeNull();
        const next = await AppInboxKeys.open(dir);
        expect(next.tokenFor(site)).toBeNull();
        expect(next.sources('fancy')).toEqual([]);
        expect(next.revokedSources('fancy')).toEqual([{ kind: 'site', id: 'site_flabs', name: 'flabs' }]);
        await next.allowSource('site', 'site_flabs');
        expect(next.tokenFor(site)).not.toBeNull();
    });

    it('lists the sources holding a token in a workspace', async () => {
        const keys = await AppInboxKeys.open(dir);
        keys.tokenFor(site);
        keys.tokenFor(proc);
        keys.tokenFor({ kind: 'site', id: 'site_x', name: 'x', workspaceId: 'tynn' });
        expect(keys.sources('fancy').map((s) => s.id).sort()).toEqual(['proc_1', 'site_flabs']);
    });

    it('only sites and processes are minted this way — a script key is the person’s to create', async () => {
        const keys = await AppInboxKeys.open(dir);
        expect(() => keys.tokenFor({ kind: 'script', id: 'k', name: 'k', workspaceId: 'fancy' })).toThrow(/script/);
    });
});

describe('a script key the person creates', () => {
    it('is shown once, kept only as a hash, bound to one workspace, and resolves across a restart', async () => {
        const keys = await AppInboxKeys.open(dir);
        const made = await keys.createScriptKey('fancy', 'nightly');
        expect(made.token).toMatch(/^gik_/);
        expect(keys.resolve(made.token)).toEqual({ kind: 'script', id: made.id, name: 'nightly', workspaceId: 'fancy' });
        const disk = await everythingOnDisk();
        expect(disk).not.toContain(made.token);
        expect(disk).toContain('nightly'); // positive control: the book WAS written
        const next = await AppInboxKeys.open(dir);
        expect(next.resolve(made.token)).toEqual({ kind: 'script', id: made.id, name: 'nightly', workspaceId: 'fancy' });
        // Listed without its secret.
        const listed = next.scriptKeys('fancy');
        expect(listed).toEqual([expect.objectContaining({ id: made.id, name: 'nightly', lastUsedAt: null })]);
        expect(JSON.stringify(listed)).not.toContain(made.token);
        expect(next.scriptKeys('tynn')).toEqual([]);
    });

    it('records when it was last used', async () => {
        const keys = await AppInboxKeys.open(dir, { now: () => '2026-10-30T23:00:00.000Z' });
        const made = await keys.createScriptKey('fancy', 'ci');
        await keys.used({ kind: 'script', id: made.id, name: 'ci', workspaceId: 'fancy' });
        expect(keys.scriptKeys('fancy')[0]!.lastUsedAt).toBe('2026-10-30T23:00:00.000Z');
    });

    it('needs a name, and refuses one already used in the workspace', async () => {
        const keys = await AppInboxKeys.open(dir);
        await expect(keys.createScriptKey('fancy', '  ')).rejects.toThrow(/name/);
        await keys.createScriptKey('fancy', 'ci');
        await expect(keys.createScriptKey('fancy', 'CI')).rejects.toThrow(/already/);
        await expect(keys.createScriptKey('tynn', 'ci')).resolves.toMatchObject({ token: expect.any(String) });
        await expect(keys.createScriptKey('fancy', 'a b/c')).rejects.toThrow(/name/);
    });

    it('Revoke: dead at once and after a restart; gone from the list', async () => {
        const keys = await AppInboxKeys.open(dir);
        const made = await keys.createScriptKey('fancy', 'ci');
        expect(await keys.revokeScriptKey(made.id)).toBe(true);
        expect(keys.resolve(made.token)).toBeNull();
        expect(keys.scriptKeys('fancy')).toEqual([]);
        expect((await AppInboxKeys.open(dir)).resolve(made.token)).toBeNull();
        expect(await keys.revokeScriptKey(made.id)).toBe(false);
    });
});
