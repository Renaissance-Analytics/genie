import { describe, expect, it } from 'vitest';
import { listRepos, relocateRepo } from '../src/core/repo-registry.js';
import { buildHostApi } from '../src/main/host-api.js';
import { relocateRepoIn, type RepoOpsPorts } from '../src/main/repo-ops-host.js';

/**
 * "LOCATE REPO" (the board's fix on a Dashboard group fault): the host asks for the folder the user picks, refuses one
 * outside the envelope, and moves the manifest's path — the registry says where the repo IS, not where it was. A
 * remote window cannot open the host's picker; it is told to do it there.
 */
const manifest = { name: 'moic', type: 'agi', repos: [{ name: 'moic', slug: 'moic', path: '.' }, { name: 'site', slug: 'site', path: 'repos/site' }, { name: 'api', slug: 'api', path: 'repos/api' }] };

describe('relocateRepo (the pure rule)', () => {
    it('moves the path, inside the envelope, and nothing else about the entry', () => {
        const r = relocateRepo(manifest, 'site', 'repos/site-v2');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(listRepos(r.manifest).map((x) => [x.slug, x.path])).toEqual([['moic', '.'], ['site', 'repos/site-v2'], ['api', 'repos/api']]);
    });

    it('refuses: an unknown slug, the host repo, a path outside the envelope, a path another repo already has', () => {
        expect(relocateRepo(manifest, 'nope', 'repos/x')).toEqual({ ok: false, reason: 'no repo with slug "nope"' });
        expect(relocateRepo(manifest, 'moic', 'repos/x')).toMatchObject({ ok: false, reason: expect.stringContaining('host repo') });
        expect(relocateRepo(manifest, 'site', '../elsewhere')).toMatchObject({ ok: false, reason: expect.stringContaining('inside the envelope') });
        expect(relocateRepo(manifest, 'site', 'repos/api')).toMatchObject({ ok: false, reason: expect.stringContaining('already registered') });
    });
});

describe('relocateRepoIn (the host)', () => {
    function fakes(existing: string[]) {
        const store: Record<string, unknown> = { '/w/moic/project.json': manifest };
        const calls: string[] = [];
        const key = (p: string) => p.replace(/\\/g, '/');
        const ports: RepoOpsPorts = {
            fs: {
                exists: async (p) => existing.includes(key(p)) || key(p) in store,
                readJson: async (p) => store[key(p)] ?? null,
                writeJson: async (p, v) => { calls.push(`writeJson:${key(p)}`); store[key(p)] = v; },
            },
            registry: { workspace: (id) => (id === 'moic' ? { id: 'moic', path: '/w/moic' } : null) },
        };
        return { ports, calls, store };
    }

    it('a picked folder inside the envelope: the manifest written with the relative path', async () => {
        const f = fakes(['/w/moic/repos/site-v2']);
        expect(await relocateRepoIn(f.ports, 'moic', 'site', '/w/moic/repos/site-v2')).toEqual({ ok: true, path: 'repos/site-v2' });
        expect(f.calls).toEqual(['writeJson:/w/moic/project.json']);
        expect(listRepos(f.store['/w/moic/project.json'] as Record<string, unknown>).find((r) => r.slug === 'site')?.path).toBe('repos/site-v2');
    });

    it('refuses a folder outside the envelope, and one that is not there — nothing written (positive control above)', async () => {
        const out = fakes(['/elsewhere/site']);
        expect(await relocateRepoIn(out.ports, 'moic', 'site', '/elsewhere/site')).toMatchObject({ ok: false, reason: expect.stringContaining('inside the envelope') });
        expect(out.calls).toEqual([]);
        const gone = fakes([]);
        expect(await relocateRepoIn(gone.ports, 'moic', 'site', '/w/moic/repos/nowhere')).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });
        expect(gone.calls).toEqual([]);
    });
});

describe('a remote window', () => {
    it('is told the picker is on the host', async () => {
        const api = buildHostApi({} as never);
        await expect(api.invoke('workspaces.locateRepo', ['moic', 'site'])).rejects.toThrow(/folder picker/);
    });
});
