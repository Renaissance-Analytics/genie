import { describe, expect, it } from 'vitest';
import { addRepo, listRepos, removeRepo } from '../src/core/repo-registry.js';

/**
 * THE REPO REGISTRY (§6.1) — pure, over the envelope manifest's `repos[]`. Add registers a folder inside
 * the envelope under a slug (unique; derived from the name); remove drops it; the HOST repo (`path: "."`)
 * cannot be removed, and the refusal says so. Every refusal is a reason, never a thrown error.
 */

const manifest = { name: 'tynn', type: 'agi', repos: [{ name: 'tynn.ai', slug: 'tynn-ai', path: '.' }, { name: 'genie2', slug: 'genie2', path: 'repos/genie2' }] };

describe('listRepos', () => {
    it('marks the host repo and keeps manifest order; a manifest without repos lists nothing', () => {
        expect(listRepos(manifest)).toEqual([
            { name: 'tynn.ai', slug: 'tynn-ai', path: '.', host: true },
            { name: 'genie2', slug: 'genie2', path: 'repos/genie2', host: false },
        ]);
        expect(listRepos({ name: 'x' })).toEqual([]);
        expect(listRepos({ repos: [{ name: 'bad' }, { name: 'ok', slug: 'ok', path: 'repos/ok' }] })).toEqual([{ name: 'ok', slug: 'ok', path: 'repos/ok', host: false }]);
    });
});

describe('addRepo', () => {
    it('adds under a slug derived from the name, keeping everything else in the manifest; the path is relative and inside the envelope', () => {
        const r = addRepo(manifest, { name: 'Fancy UI', path: 'repos/fancy' });
        expect(r).toMatchObject({ ok: true, slug: 'fancy-ui' });
        const next = (r as { ok: true; manifest: Record<string, unknown> }).manifest;
        expect(next.name).toBe('tynn');
        expect(listRepos(next).map((x) => x.slug)).toEqual(['tynn-ai', 'genie2', 'fancy-ui']);
        const docs = addRepo(manifest, { name: 'Docs', path: './repos/docs/' }) as { ok: true; manifest: Record<string, unknown> };
        expect(listRepos(docs.manifest).at(-1)).toMatchObject({ slug: 'docs', path: 'repos/docs' });
    });

    it('refuses a duplicate slug or path, a path outside the envelope, an empty name — each with its reason', () => {
        expect(addRepo(manifest, { name: 'genie2', path: 'repos/other' })).toEqual({ ok: false, reason: 'a repo with slug "genie2" is already registered' });
        expect(addRepo(manifest, { name: 'Other', path: 'repos/genie2' })).toEqual({ ok: false, reason: 'repos/genie2 is already registered as "genie2"' });
        expect(addRepo(manifest, { name: 'Up', path: '../elsewhere' })).toEqual({ ok: false, reason: 'a repo must live inside the envelope; ../elsewhere is outside it' });
        expect(addRepo(manifest, { name: 'Abs', path: '/abs/path' })).toMatchObject({ ok: false, reason: expect.stringMatching(/inside the envelope/) });
        expect(addRepo(manifest, { name: '   ', path: 'repos/x' })).toEqual({ ok: false, reason: 'a repo needs a name' });
    });
});

describe('removeRepo', () => {
    it('removes by slug and leaves the rest; the host repo is refused BY NAME; an unknown slug is a reason, not an error', () => {
        const r = removeRepo(manifest, 'genie2');
        expect(r.ok).toBe(true);
        expect(listRepos((r as { ok: true; manifest: Record<string, unknown> }).manifest).map((x) => x.slug)).toEqual(['tynn-ai']);
        expect(removeRepo(manifest, 'tynn-ai')).toEqual({ ok: false, reason: '"tynn-ai" is the host repo (the envelope itself) and cannot be removed' });
        expect(removeRepo(manifest, 'nope')).toEqual({ ok: false, reason: 'no repo with slug "nope"' });
    });
});
