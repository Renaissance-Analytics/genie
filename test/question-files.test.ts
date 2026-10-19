import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existingFiles, readQuestionFile } from '../src/main/question-files.js';

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

    it('a binary file and a missing file each say so', async () => {
        expect(await readQuestionFile(root, 'bin.dat')).toEqual({ ok: false, reason: 'not a text file' });
        expect(await readQuestionFile(root, 'nope/missing.md')).toEqual({ ok: false, reason: 'no such file' });
    });
});

describe('existingFiles', () => {
    it('which of the named paths are there, inside the workspace (COUNTED)', async () => {
        const got = await existingFiles(root, ['.ai/plans/spec.md', 'nope/missing.md', '../escape.md', join(outside, 'secret.txt')]);
        expect([...got]).toEqual(['.ai/plans/spec.md']);
    });
});
