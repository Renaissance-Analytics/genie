import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Attachment } from '../src/core/prompt-content.js';
import { saveChatUploads, type UploadWorkspace } from '../src/main/chat-uploads.js';

/**
 * THE HOST SAVES A FILE THAT IS NOT AN IMAGE OR TEXT INTO THE AGENT'S WORKSPACE (Tynn #829).
 *
 * `.ai/_dirty/uploads/<date>/<safe name>`, on a real folder: the bytes are the bytes sent, the message gets the path, and
 * nothing is ever written outside the workspace, through a link, over an existing file, into an untrusted or hibernated
 * workspace, or for a message that is refused. Every refusal here has its CONTROL: the same setup, made legal, saves.
 */
const MB = 1024 * 1024;
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0x00, 0x00, 0x21, 0x00, 0xff, 0xfe]);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const LETTERHEAD = "Wish's Wonders Letterhead.docx";
const NOW = new Date(2026, 10, 17, 18, 34);
const DAY = '.ai/_dirty/uploads/2026-11-17';

let base = '';
let root = '';
let outside = '';
beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'genie-829-'));
    root = join(base, 'workspace');
    outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

const ws = (over: Partial<UploadWorkspace> = {}): UploadWorkspace => ({ path: root, asleep: false, untrusted: false, ...over });
const docx = (name = LETTERHEAD, bytes: Uint8Array = DOCX): Attachment => ({ name, type: DOCX_TYPE, bytes });
const listOutside = () => readdir(outside, { recursive: true });

describe('saving a file the agent cannot take inline', () => {
    it('the owner\'s docx is written to .ai/_dirty/uploads/<date>/ with its bytes; the message gets its path, type and size', async () => {
        const r = await saveChatUploads({ workspace: ws(), files: [docx()], now: NOW });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const [a] = r.files;
        expect(a!.name).toBe(LETTERHEAD);
        expect(a!.saved).toEqual({ path: `${DAY}/${LETTERHEAD}`, type: DOCX_TYPE, size: DOCX.byteLength });
        // Not carried further: the agent reads the file, the engine wire does not carry 25 MB again.
        expect(a!.bytes.byteLength).toBe(0);
        expect(Buffer.from(await readFile(join(root, DAY, LETTERHEAD))).equals(Buffer.from(DOCX))).toBe(true);
        // Never committed, whatever the root's .gitignore says.
        expect(await readFile(join(root, '.ai/_dirty/uploads/.gitignore'), 'utf8')).toBe('*\n');
    });

    it('CONTROL: an image and a text file pass through untouched, and nothing is written', async () => {
        const files: Attachment[] = [{ name: 'shot.png', type: 'image/png', bytes: PNG }, { name: 'a.txt', type: 'text/plain', bytes: new TextEncoder().encode('x') }];
        const r = await saveChatUploads({ workspace: ws(), files, now: NOW });
        expect(r).toEqual({ ok: true, files });
        expect(existsSync(join(root, '.ai'))).toBe(false);
    });

    it('the same name twice never overwrites: the second is "name (2).docx"', async () => {
        await saveChatUploads({ workspace: ws(), files: [docx('t.docx', new Uint8Array([0x50, 0x4b, 1, 0]))], now: NOW });
        const r = await saveChatUploads({ workspace: ws(), files: [docx('t.docx', new Uint8Array([0x50, 0x4b, 2, 0]))], now: NOW });
        expect(r.ok && r.files[0]!.saved?.path).toBe(`${DAY}/t (2).docx`);
        expect([...(await readFile(join(root, DAY, 't.docx')))]).toEqual([0x50, 0x4b, 1, 0]);
        expect([...(await readFile(join(root, DAY, 't (2).docx')))]).toEqual([0x50, 0x4b, 2, 0]);
    });

    it('a name with a path in it lands as its base name in the day\'s folder, and nothing outside the workspace', async () => {
        const r = await saveChatUploads({ workspace: ws(), files: [docx('../../outside/evil.docx')], now: NOW });
        expect(r.ok && r.files[0]!.saved?.path).toBe(`${DAY}/evil.docx`);
        expect(existsSync(join(root, DAY, 'evil.docx'))).toBe(true);
        expect(await listOutside()).toEqual([]);
    });
});

describe('refusals, each with the reason, and nothing written', () => {
    it('an untrusted workspace refuses, saying it is not trusted', async () => {
        const r = await saveChatUploads({ workspace: ws({ untrusted: true }), files: [docx()], now: NOW });
        expect(r.ok ? 'saved' : r.reason).toMatch(new RegExp(`${LETTERHEAD.replace(/[.']/g, '.')}.*not trusted`));
        expect(existsSync(join(root, '.ai'))).toBe(false);
    });

    it('a hibernated workspace refuses, saying it is hibernated', async () => {
        const r = await saveChatUploads({ workspace: ws({ asleep: true }), files: [docx()], now: NOW });
        expect(r.ok ? 'saved' : r.reason).toMatch(/hibernated/);
        expect(existsSync(join(root, '.ai'))).toBe(false);
    });

    it('an agent with no workspace refuses, saying so', async () => {
        const r = await saveChatUploads({ workspace: null, files: [docx()], now: NOW });
        expect(r.ok ? 'saved' : r.reason).toMatch(/no workspace/);
    });

    it('over 25 MB, or an executable, is refused before anything is written', async () => {
        const big = await saveChatUploads({ workspace: ws(), files: [docx('big.zip', new Uint8Array(25 * MB + 1))], now: NOW });
        expect(big.ok ? 'saved' : big.reason).toMatch(/25 MB/);
        const exe = await saveChatUploads({ workspace: ws(), files: [docx('setup.exe', new Uint8Array([0x4d, 0x5a, 0, 0]))], now: NOW });
        expect(exe.ok ? 'saved' : exe.reason).toMatch(/executable/);
        expect(existsSync(join(root, '.ai'))).toBe(false);
    });

    it('.ai/_dirty as a link out of the workspace is never written through (a junction: Windows makes one unprivileged)', async () => {
        await mkdir(join(root, '.ai'));
        await symlink(outside, join(root, '.ai/_dirty'), 'junction');
        const r = await saveChatUploads({ workspace: ws(), files: [docx()], now: NOW });
        expect(r.ok ? 'saved' : r.reason).toMatch(/link/);
        expect(await listOutside()).toEqual([]);
    });

    it('a link inside the workspace is refused too: never THROUGH a link, wherever it points', async () => {
        await mkdir(join(root, '.ai'));
        await mkdir(join(root, 'elsewhere'));
        await symlink(join(root, 'elsewhere'), join(root, '.ai/_dirty'), 'junction');
        const r = await saveChatUploads({ workspace: ws(), files: [docx()], now: NOW });
        expect(r.ok ? 'saved' : r.reason).toMatch(/link/);
        expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
    });

    it('a file where a folder must be is refused; CONTROL: an existing real .ai/_dirty is used as it is', async () => {
        await mkdir(join(root, '.ai'));
        await writeFile(join(root, '.ai/_dirty'), 'not a folder');
        const r = await saveChatUploads({ workspace: ws(), files: [docx()], now: NOW });
        expect(r.ok ? 'saved' : r.reason).toMatch(/not a folder/);

        await rm(join(root, '.ai/_dirty'));
        await mkdir(join(root, '.ai/_dirty'));
        await writeFile(join(root, '.ai/_dirty/.gitkeep'), '');
        const ok = await saveChatUploads({ workspace: ws(), files: [docx()], now: NOW });
        expect(ok.ok).toBe(true);
        expect(existsSync(join(root, '.ai/_dirty/.gitkeep'))).toBe(true);
    });

    it('when one file of a message cannot be saved, the ones already saved are removed: no half-sent message leaves files', async () => {
        // A clash is not a failure (it takes the next free name), so the failure is the one that is: no free name left.
        await mkdir(join(root, DAY), { recursive: true });
        for (let i = 2; i <= 100; i++) await writeFile(join(root, DAY, `again (${i}).docx`), '');
        await writeFile(join(root, DAY, 'again.docx'), '');
        const full = await saveChatUploads({ workspace: ws(), files: [docx('kept-not.docx'), docx('again.docx')], now: NOW });
        expect(full.ok ? 'saved' : full.reason).toMatch(/again\.docx/);
        expect(existsSync(join(root, DAY, 'kept-not.docx'))).toBe(false);
    });
});
