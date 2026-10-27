import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A CHAT'S DRAFT SURVIVES A RESTART (genie#1261, the persistence half). #1262 kept each chat's composer mounted, so a
 * draft outlived a switch and a window close — but not a Genie restart or a renderer reload, because react-fancy's
 * `PromptInput` had no draft API. 5.65.0 has one (`defaultDraft`, `onDraftChange`, `persistAttachment`,
 * `restoreAttachment`), and Genie keeps the drafts where Genie 1 kept its part-typed answers: in MAIN, on disk, keyed by
 * what the draft belongs to (v0.7.0-beta.342 `main/ask/force-question.ts:1118` "in settings so they survive a window
 * being destroyed AND an app restart", `:1181-1217` read/write/forget; `main/ask/draft-store.ts` parse/prune).
 *
 * The draft is JSON; an attachment's BYTES are a file of their own under Genie's data, named by a ref main mints, never
 * base64 inside the JSON.
 *
 * Imported where used: on origin/main the store does not exist, and a top-level import would fail every test for "not
 * found" instead of each for its own reason.
 */
const storeModule = () => import('../src/main/chat-draft-store.js');
const core = () => import('../src/core/chat-drafts.js');

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'genie-chat-drafts-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const filesIn = async (dir: string): Promise<string[]> => { try { return (await readdir(dir)).sort(); } catch { return []; } };

describe('the draft round-trips through the store, attachments included', () => {
    it('text, a paste pill, an image pill and an attachment: saved, Genie restarted, read back whole — the bytes too', async () => {
        const { ChatDraftStore } = await storeModule();
        const first = await ChatDraftStore.open(home);
        const imageRef = await first.putFile(PNG);
        const fileRef = await first.putFile(new TextEncoder().encode('notes'));
        expect(imageRef).toMatch(/^[0-9a-f-]{36}$/);
        expect(fileRef).not.toBe(imageRef);
        const draft = {
            v: 1 as const,
            text: 'look at ⁣p1⁣ and ⁣i1⁣',
            pills: [
                { kind: 'text' as const, id: 'p1', text: 'a long paste' },
                { kind: 'image' as const, id: 'i1', label: 'Pasted image 1', file: { id: 'i1', name: 'Pasted image 1.png', type: 'image/png', bytes: PNG.length, ref: imageRef! } },
            ],
            attachments: [{ id: 'f1', name: 'notes.txt', type: 'text/plain', bytes: 5, ref: fileRef! }],
        };
        await first.save('a_lark', draft);

        // A restart: a new store over the same directory.
        const second = await ChatDraftStore.open(home);
        expect(second.all()).toEqual({ a_lark: draft });
        expect(await second.readFile(imageRef!)).toEqual(PNG);
        expect(new TextDecoder().decode((await second.readFile(fileRef!))!)).toBe('notes');
    });

    it('the bytes are NOT in the JSON: the drafts file holds the ref, the file holds the bytes', async () => {
        const { ChatDraftStore } = await storeModule();
        const s = await ChatDraftStore.open(home);
        const ref = await s.putFile(new Uint8Array(4096).fill(7));
        await s.save('a_lark', { v: 1, text: 'x', pills: [], attachments: [{ id: 'f', name: 'big.bin', type: '', bytes: 4096, ref: ref! }] });
        const json = await readFile(s.file, 'utf8');
        expect(json).toContain(ref!);
        expect(json.length).toBeLessThan(1000);
    });

    it('two chats, two drafts: each read back under its own agent', async () => {
        const { ChatDraftStore } = await storeModule();
        const s = await ChatDraftStore.open(home);
        await s.save('a_lark', { v: 1, text: 'to lark', pills: [], attachments: [] });
        await s.save('a_wren', { v: 1, text: 'to wren', pills: [], attachments: [] });
        const again = await ChatDraftStore.open(home);
        expect(Object.fromEntries(Object.entries(again.all()).map(([k, d]) => [k, d.text]))).toEqual({ a_lark: 'to lark', a_wren: 'to wren' });
    });

    it('an empty draft (or null) removes the chat’s entry, and only that chat’s', async () => {
        const { ChatDraftStore } = await storeModule();
        const s = await ChatDraftStore.open(home);
        await s.save('a_lark', { v: 1, text: 'to lark', pills: [], attachments: [] });
        await s.save('a_wren', { v: 1, text: 'to wren', pills: [], attachments: [] });
        await s.save('a_lark', { v: 1, text: '   ', pills: [], attachments: [] });
        expect(Object.keys((await ChatDraftStore.open(home)).all())).toEqual(['a_wren']);
        await s.save('a_wren', null);
        expect((await ChatDraftStore.open(home)).all()).toEqual({});
    });

    it('Genie 1’s rule: an unreadable drafts file reads as no drafts (a lost draft must never take the chat down), and one bad entry does not take the rest', async () => {
        const { ChatDraftStore } = await storeModule();
        const s = await ChatDraftStore.open(home);
        await mkdir(dirname(s.file), { recursive: true });
        await writeFile(s.file, '{ not json', 'utf8');
        expect((await ChatDraftStore.open(home)).all()).toEqual({});
        await writeFile(s.file, JSON.stringify({ a_lark: { v: 1, text: 'kept', pills: [], attachments: [] }, a_wren: { v: 99, text: 'future' }, a_owl: 'nonsense' }), 'utf8');
        expect((await ChatDraftStore.open(home)).all()).toEqual({ a_lark: { v: 1, text: 'kept', pills: [], attachments: [] } });
    });

    it('a ref that is not one main minted is refused: never a path out of the drafts folder', async () => {
        const { ChatDraftStore } = await storeModule();
        const s = await ChatDraftStore.open(home);
        await writeFile(join(home, 'secret.txt'), 'secret', 'utf8');
        expect(await s.readFile('../../secret.txt')).toBeNull();
        expect(await s.readFile('..')).toBeNull();
        expect(await s.readFile('00000000-0000-4000-8000-000000000000')).toBeNull(); // well-formed, never written
    });
});

describe('cleanup: files no longer referenced are removed', () => {
    it('release(refs) — what a send calls once the message has the bytes — removes exactly those files', async () => {
        const { ChatDraftStore } = await storeModule();
        const s = await ChatDraftStore.open(home);
        const sent = await s.putFile(PNG);
        const kept = await s.putFile(PNG);
        await s.release([sent!]);
        expect(await s.readFile(sent!)).toBeNull();
        expect(await s.readFile(kept!)).toEqual(PNG);
        expect(await filesIn(s.filesDir)).toEqual([kept]);
        await s.release(['../../secret.txt']); // refused quietly, nothing outside touched
    });

    it('a deleted agent’s draft is removed, with its files; every other chat keeps its own', async () => {
        const { ChatDraftStore } = await storeModule();
        const s = await ChatDraftStore.open(home);
        const larks = await s.putFile(PNG);
        const wrens = await s.putFile(PNG);
        await s.save('a_lark', { v: 1, text: 'to lark', pills: [], attachments: [{ id: 'f', name: 'a.png', type: 'image/png', bytes: PNG.length, ref: larks! }] });
        await s.save('a_wren', { v: 1, text: 'to wren', pills: [], attachments: [{ id: 'f', name: 'b.png', type: 'image/png', bytes: PNG.length, ref: wrens! }] });
        await s.prune(['a_wren', 'a_owl']);
        expect(Object.keys(s.all())).toEqual(['a_wren']);
        expect(Object.keys((await ChatDraftStore.open(home)).all())).toEqual(['a_wren']);
        expect(await filesIn(s.filesDir)).toEqual([wrens]);
    });

    it('CONTROL: a prune with every agent still there changes nothing and writes nothing', async () => {
        const { ChatDraftStore } = await storeModule();
        const s = await ChatDraftStore.open(home);
        await s.save('a_lark', { v: 1, text: 'to lark', pills: [], attachments: [] });
        const before = await readFile(s.file, 'utf8');
        await writeFile(s.file, before.replace('to lark', 'to lark, edited on disk'), 'utf8');
        await s.prune(['a_lark']);
        expect(await readFile(s.file, 'utf8')).toContain('edited on disk');
    });

    it('at open, files no draft references (a chip removed, a quit before the ref was saved) are swept; referenced ones stay', async () => {
        const { ChatDraftStore } = await storeModule();
        const s = await ChatDraftStore.open(home);
        const used = await s.putFile(PNG);
        const orphan = await s.putFile(PNG);
        await s.save('a_lark', { v: 1, text: 'x', pills: [], attachments: [{ id: 'f', name: 'a.png', type: 'image/png', bytes: PNG.length, ref: used! }] });
        await mkdir(s.filesDir, { recursive: true });
        await writeFile(join(s.filesDir, 'stray.tmp'), 'x');
        expect(await filesIn(s.filesDir)).toHaveLength(3);
        const reopened = await ChatDraftStore.open(home);
        expect(await filesIn(reopened.filesDir)).toEqual([used]);
        expect(await reopened.readFile(orphan!)).toBeNull();
    });
});

describe('the pure half (core/chat-drafts.ts)', () => {
    it('refs of a draft: attachments and image pills, nothing else', async () => {
        const { draftRefs } = await core();
        expect(draftRefs({ v: 1, text: '', pills: [{ kind: 'text', id: 'p', text: 't' }, { kind: 'image', id: 'i', label: 'L', file: { id: 'i', name: 'n', type: '', bytes: 1, ref: 'r-image' } }], attachments: [{ id: 'a', name: 'n', type: '', bytes: 1, ref: 'r-file' }, { id: 'b', name: 'n', type: '', bytes: 1 }] }))
            .toEqual(['r-file', 'r-image']);
    });

    it('empty means nothing to keep: no text but whitespace, no pills, no attachments', async () => {
        const { isEmptyDraft } = await core();
        expect(isEmptyDraft({ v: 1, text: ' \n', pills: [], attachments: [] })).toBe(true);
        expect(isEmptyDraft({ v: 1, text: '', pills: [], attachments: [{ id: 'a', name: 'n', type: '', bytes: 1 }] })).toBe(false);
        expect(isEmptyDraft({ v: 1, text: 'hi', pills: [], attachments: [] })).toBe(false);
    });
});
