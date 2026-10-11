import { describe, expect, it } from 'vitest';
import { addRepoTo, listReposOf, removeRepoFrom, type RepoOpsPorts } from '../src/main/repo-ops-host.js';

/**
 * REPO OPERATIONS IN THE APP (§6.1) — the main-process half over the pure registry. Reads the envelope's
 * project.json through ports, applies the registry rule, writes the manifest back. A workspace without a
 * manifest is told to convert first; a folder that does not exist is refused before anything is written;
 * the host repo cannot be removed. Every refusal is a reason.
 */

function fakes(files: Record<string, unknown>, existing: string[] = []) {
    const store: Record<string, unknown> = { ...files };
    const calls: string[] = [];
    const key = (p: string) => p.replace(/\\/g, '/');
    const ports: RepoOpsPorts = {
        fs: {
            exists: async (p) => existing.includes(key(p)) || key(p) in store,
            readJson: async (p) => store[key(p)] ?? null,
            writeJson: async (p, v) => { calls.push(`writeJson:${key(p)}`); store[key(p)] = v; },
        },
        registry: { workspace: (id) => (id === 'tynn' ? { id: 'tynn', path: '/w/tynn' } : null) },
    };
    return { ports, calls, store };
}

const manifest = { name: 'tynn', type: 'agi', repos: [{ name: 'tynn.ai', slug: 'tynn-ai', path: '.' }, { name: 'genie2', slug: 'genie2', path: 'repos/genie2' }] };

describe('repo operations', () => {
    it('lists from the manifest; an unknown workspace or a missing manifest is a reason', async () => {
        const f = fakes({ '/w/tynn/project.json': manifest });
        expect(await listReposOf(f.ports, 'tynn')).toEqual({ ok: true, repos: [{ name: 'tynn.ai', slug: 'tynn-ai', path: '.', host: true }, { name: 'genie2', slug: 'genie2', path: 'repos/genie2', host: false }] });
        expect(await listReposOf(f.ports, 'nope')).toEqual({ ok: false, reason: 'no workspace "nope"' });
        expect(await listReposOf(fakes({}).ports, 'tynn')).toEqual({ ok: false, reason: 'this workspace has no project.json; convert it to an envelope first' });
    });

    it('add checks the folder exists, then writes the manifest once; refusals write nothing', async () => {
        const f = fakes({ '/w/tynn/project.json': manifest }, ['/w/tynn/repos/fancy']);
        expect(await addRepoTo(f.ports, 'tynn', { name: 'Fancy', path: 'repos/fancy' })).toMatchObject({ ok: true, slug: 'fancy' });
        expect(f.calls).toEqual(['writeJson:/w/tynn/project.json']);
        expect((f.store['/w/tynn/project.json'] as { repos: unknown[] }).repos).toHaveLength(3);
        expect(await addRepoTo(f.ports, 'tynn', { name: 'Ghost', path: 'repos/ghost' })).toEqual({ ok: false, reason: 'repos/ghost does not exist inside the envelope; clone or create it first' });
        expect(await addRepoTo(f.ports, 'tynn', { name: 'genie2', path: 'repos/fancy' })).toEqual({ ok: false, reason: 'a repo with slug "genie2" is already registered' });
        expect(f.calls).toHaveLength(1);
    });

    it('remove drops the entry and writes; the host repo is refused and nothing is written', async () => {
        const f = fakes({ '/w/tynn/project.json': manifest });
        expect(await removeRepoFrom(f.ports, 'tynn', 'genie2')).toEqual({ ok: true });
        expect((f.store['/w/tynn/project.json'] as { repos: unknown[] }).repos).toHaveLength(1);
        expect(await removeRepoFrom(f.ports, 'tynn', 'tynn-ai')).toEqual({ ok: false, reason: '"tynn-ai" is the host repo (the envelope itself) and cannot be removed' });
        expect(f.calls).toEqual(['writeJson:/w/tynn/project.json']);
    });
});
