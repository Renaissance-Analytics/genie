import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existingFiles, MAX_MEDIA_BYTES, readQuestionFile } from '../src/main/question-files.js';

/**
 * THE FILES A QUESTION NAMES, READ FOR ITS DRAWER (Genie 1's ForceTheQuestion file drawer; the owner, 2026-10-19). A
 * question's paths are prose an AGENT wrote, so they are untrusted: each resolves inside the ASKING workspace or not at
 * all — no `..` out of it, no absolute path elsewhere — and only text is shown, up to a cap.
 */

let root: string;
let outside: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-qfiles-'));
    outside = await mkdtemp(join(tmpdir(), 'genie2-qfiles-out-'));
    await mkdir(join(root, '.ai', 'plans'), { recursive: true });
    await writeFile(join(root, '.ai', 'plans', 'spec.md'), '# Spec\n\n§3 holds.\n');
    await writeFile(join(root, 'bin.dat'), Buffer.from([0x50, 0x00, 0x4b]));
    await writeFile(join(outside, 'secret.txt'), 'not yours');
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
});

describe('readQuestionFile', () => {
    it('a file the question names, relative to its workspace: its text', async () => {
        expect(await readQuestionFile(root, '.ai/plans/spec.md')).toEqual({ ok: true, path: '.ai/plans/spec.md', text: '# Spec\n\n§3 holds.\n' });
    });

    it('an absolute path INSIDE the workspace is read; one outside it is refused, never read', async () => {
        expect((await readQuestionFile(root, join(root, '.ai', 'plans', 'spec.md'))).ok).toBe(true);
        const r = await readQuestionFile(root, join(outside, 'secret.txt'));
        expect(r).toEqual({ ok: false, reason: 'that file is not in this workspace' });
    });

    it('`..` out of the workspace is refused, however it is written', async () => {
        for (const p of ['../x.txt', '.ai/../../x.txt', '..\\x.txt']) {
            expect(await readQuestionFile(root, p), p).toEqual({ ok: false, reason: 'that file is not in this workspace' });
        }
    });

    it('CONTROL: a file whose NAME starts with two dots is inside, and is read', async () => {
        await writeFile(join(root, '..notes.md'), 'kept');
        expect(await readQuestionFile(root, '..notes.md')).toEqual({ ok: true, path: '..notes.md', text: 'kept' });
    });

    it('a missing file says so', async () => {
        expect(await readQuestionFile(root, 'nope/missing.md')).toEqual({ ok: false, reason: 'no such file' });
    });
});

describe('existingFiles', () => {
    it('which of the named paths are there, inside the workspace (COUNTED)', async () => {
        const got = await existingFiles(root, ['.ai/plans/spec.md', 'nope/missing.md', '../escape.md', join(outside, 'secret.txt')]);
        expect([...got]).toEqual(['.ai/plans/spec.md']);
    });
});

/*
 * genie#1354: a question's paths are an agent's words, so they go through the SHARED confinement (workspace-confine.ts),
 * which follows links: a symlink or junction inside the workspace pointing out of it is refused, never read, and never
 * gets a chip. The lexical check alone read straight through it.
 */
describe('after links (genie#1354)', () => {
    it('a directory link inside the workspace that points OUT is refused, never read, and gets no chip', async () => {
        await symlink(outside, join(root, 'escape'), 'junction');
        expect(await readQuestionFile(root, 'escape/secret.txt')).toEqual({ ok: false, reason: 'that file is not in this workspace' });
        expect(await existingFiles(root, ['escape/secret.txt', '.ai/plans/spec.md'])).toEqual(new Set(['.ai/plans/spec.md']));
    });

    it('POSITIVE CONTROL: a link that stays inside the workspace is read', async () => {
        await symlink(join(root, '.ai'), join(root, 'alias'), 'junction');
        expect(await readQuestionFile(root, 'alias/plans/spec.md')).toMatchObject({ ok: true, text: expect.stringContaining('§3 holds.') });
    });
});

/*
 * Tynn #726: a PNG named in a question used to say "not a text file". Images come back as bytes the drawer can draw (a data:
 * URL, as the Files panel's), a PDF and any other binary as their name's size — the SAME confinement for all of them.
 */
describe('media and binaries (Tynn #726)', () => {
    const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    beforeEach(async () => {
        await writeFile(join(root, 'shot.png'), PNG);
        await writeFile(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        await writeFile(join(root, 'doc.pdf'), Buffer.from('%PDF-1.4\n\0'));
        await writeFile(join(outside, 'leak.png'), PNG);
    });

    it('an image: its bytes as a data: URL of its own type, with its size', async () => {
        expect(await readQuestionFile(root, 'shot.png')).toEqual({ ok: true, path: 'shot.png', media: { kind: 'image', src: `data:image/png;base64,${PNG.toString('base64')}`, size: PNG.length } });
    });

    it('an SVG is an image too (typed image/svg+xml), never text', async () => {
        const r = await readQuestionFile(root, 'logo.svg');
        expect(r).toMatchObject({ ok: true, media: { kind: 'image' } });
        expect((r as { media: { src: string } }).media.src.startsWith('data:image/svg+xml;base64,')).toBe(true);
        expect(r).not.toHaveProperty('text');
    });

    it('a PDF is named with its size, no bytes sent; another binary likewise (it used to say "not a text file")', async () => {
        expect(await readQuestionFile(root, 'doc.pdf')).toEqual({ ok: true, path: 'doc.pdf', media: { kind: 'pdf', size: 10 } });
        expect(await readQuestionFile(root, 'bin.dat')).toEqual({ ok: true, path: 'bin.dat', media: { kind: 'binary', size: 3 } });
    });

    it('an image over the cap is named with its size, not sent', async () => {
        await writeFile(join(root, 'huge.png'), Buffer.alloc(MAX_MEDIA_BYTES + 1));
        expect(await readQuestionFile(root, 'huge.png')).toEqual({ ok: true, path: 'huge.png', media: { kind: 'binary', size: MAX_MEDIA_BYTES + 1 } });
    });

    it('SCOPE UNCHANGED: an image outside the workspace, by `..`, absolute path or link, is refused and never read', async () => {
        const refused = { ok: false, reason: 'that file is not in this workspace' };
        expect(await readQuestionFile(root, join(outside, 'leak.png'))).toEqual(refused);
        expect(await readQuestionFile(root, '../leak.png')).toEqual(refused);
        await symlink(outside, join(root, 'out-link'), 'junction');
        expect(await readQuestionFile(root, 'out-link/leak.png')).toEqual(refused);
    });
});
