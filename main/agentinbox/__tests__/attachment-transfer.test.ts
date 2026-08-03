import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_MESSAGE_ATTACHMENT_BYTES,
    collectAttachmentsForSend,
    saveAttachmentToWorkspace,
    storeInlineAttachments,
} from '../attachments';
import type { StoredAttachment } from '../store';

/**
 * The two ENDS of an attachment transfer as the MCP tool performs them:
 * `send` turning the sender's file paths into stored, addressed metadata, and
 * `saveAttachment` putting those bytes down inside the RECIPIENT's workspace.
 *
 * Both are pulled out of `host-tools` as plain functions so the caps and the
 * all-or-nothing behaviour are provable without a live terminal, workspace row
 * or MCP session.
 */

let sender: string;
let recipient: string;
let blobs: string;
const dirs: string[] = [];

function tmp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
}

beforeEach(() => {
    sender = tmp('genie-att-send-');
    recipient = tmp('genie-att-recv-');
    blobs = tmp('genie-att-blobs-');
});

afterAll(() => {
    for (const d of dirs) {
        try {
            fs.rmSync(d, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
    }
});

function seed(rel: string, content: string | Buffer): void {
    const abs = path.join(sender, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

let n = 0;
const ids = () => `att-${++n}`;

describe('collectAttachmentsForSend', () => {
    it('reads each file from the SENDER workspace and returns addressed metadata', async () => {
        seed('docs/notes.md', '# hello');
        seed('data.csv', 'a,b\n1,2\n');

        const out = await collectAttachmentsForSend({
            workspaceRoot: sender,
            paths: ['docs/notes.md', 'data.csv'],
            storeRoot: blobs,
            newId: ids,
        });

        expect(out.map((a) => a.filename)).toEqual(['notes.md', 'data.csv']);
        expect(out[0].mime).toBe('text/markdown');
        expect(out[0].bytes).toBe(Buffer.byteLength('# hello'));
        expect(out[0].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(new Set(out.map((a) => a.id)).size).toBe(2);
    });

    it('stores the BYTES centrally — the recipient never needs the sender path', async () => {
        seed('a.txt', 'payload');
        const [att] = await collectAttachmentsForSend({
            workspaceRoot: sender,
            paths: ['a.txt'],
            storeRoot: blobs,
            newId: ids,
        });

        fs.rmSync(path.join(sender, 'a.txt'));

        const saved = await saveAttachmentToWorkspace({
            workspaceRoot: recipient,
            storeRoot: blobs,
            attachment: { ...att, messageId: 'm1' },
        });
        expect(fs.readFileSync(path.join(recipient, saved.relPath), 'utf8')).toBe('payload');
    });

    it('is ALL-OR-NOTHING — one bad path fails the whole send', async () => {
        seed('good.txt', 'ok');

        await expect(
            collectAttachmentsForSend({
                workspaceRoot: sender,
                paths: ['good.txt', '../escape.txt'],
                storeRoot: blobs,
                newId: ids,
            }),
        ).rejects.toThrow(/escape\.txt/);
    });

    it('refuses more than the per-message file count', async () => {
        const paths: string[] = [];
        for (let i = 0; i <= MAX_ATTACHMENTS_PER_MESSAGE; i++) {
            seed(`f${i}.txt`, `${i}`);
            paths.push(`f${i}.txt`);
        }

        await expect(
            collectAttachmentsForSend({ workspaceRoot: sender, paths, storeRoot: blobs, newId: ids }),
        ).rejects.toThrow(new RegExp(`${MAX_ATTACHMENTS_PER_MESSAGE}`));
    });

    it('refuses a set whose TOTAL exceeds the per-message byte budget', async () => {
        // Two files, each comfortably UNDER the per-file cap, that together blow
        // the message budget — the case a per-file check alone would wave through.
        // The caps are injected so this proves the total, not the per-file limit.
        seed('a.bin', Buffer.alloc(600, 1));
        seed('b.bin', Buffer.alloc(600, 2));

        await expect(
            collectAttachmentsForSend({
                workspaceRoot: sender,
                paths: ['a.bin', 'b.bin'],
                storeRoot: blobs,
                newId: ids,
                maxBytes: 1000,
                maxTotalBytes: 1000,
            }),
        ).rejects.toThrow(/total/i);

        // …and the same pair is fine when the budget allows it.
        await expect(
            collectAttachmentsForSend({
                workspaceRoot: sender,
                paths: ['a.bin', 'b.bin'],
                storeRoot: blobs,
                newId: ids,
                maxBytes: 1000,
                maxTotalBytes: 2000,
            }),
        ).resolves.toHaveLength(2);
    });

    it('exposes sane defaults for the caps', () => {
        expect(MAX_ATTACHMENTS_PER_MESSAGE).toBeGreaterThan(0);
        expect(MAX_MESSAGE_ATTACHMENT_BYTES).toBeGreaterThan(0);
    });

    it('returns an empty list for no paths, without touching the store', async () => {
        expect(
            await collectAttachmentsForSend({
                workspaceRoot: sender,
                paths: [],
                storeRoot: blobs,
                newId: ids,
            }),
        ).toEqual([]);
    });
});

describe('storeInlineAttachments (the HUMAN panel side)', () => {
    // The human attaches through the browser file input, so the bytes arrive
    // INLINE (base64) rather than as a host path — the panel never needs a
    // filesystem capability, and a remote human attaches from their OWN machine.
    it('stores the bytes and describes them like any other attachment', async () => {
        const out = await storeInlineAttachments({
            files: [{ filename: 'notes.md', base64: Buffer.from('# hi').toString('base64') }],
            storeRoot: blobs,
            newId: ids,
        });

        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ filename: 'notes.md', bytes: 4, mime: 'text/markdown' });
        expect(out[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('STRIPS any path the client put in the filename', async () => {
        const [att] = await storeInlineAttachments({
            files: [{ filename: '../../etc/passwd', base64: Buffer.from('x').toString('base64') }],
            storeRoot: blobs,
            newId: ids,
        });
        expect(att.filename).toBe('passwd');
    });

    it('refuses an executable file type, exactly like the agent path', async () => {
        await expect(
            storeInlineAttachments({
                files: [{ filename: 'setup.exe', base64: Buffer.from('MZ').toString('base64') }],
                storeRoot: blobs,
                newId: ids,
            }),
        ).rejects.toThrow(/executable/i);
    });

    it('applies the same per-file and per-message caps', async () => {
        const big = Buffer.alloc(2048, 7).toString('base64');
        await expect(
            storeInlineAttachments({
                files: [{ filename: 'a.bin', base64: big }],
                storeRoot: blobs,
                newId: ids,
                maxBytes: 1024,
            }),
        ).rejects.toThrow(/too large/i);

        await expect(
            storeInlineAttachments({
                files: [
                    { filename: 'a.bin', base64: Buffer.alloc(600, 1).toString('base64') },
                    { filename: 'b.bin', base64: Buffer.alloc(600, 2).toString('base64') },
                ],
                storeRoot: blobs,
                newId: ids,
                maxTotalBytes: 1000,
            }),
        ).rejects.toThrow(/total/i);
    });

    it('refuses an empty file rather than storing a zero-byte attachment', async () => {
        await expect(
            storeInlineAttachments({
                files: [{ filename: 'empty.txt', base64: '' }],
                storeRoot: blobs,
                newId: ids,
            }),
        ).rejects.toThrow(/empty/i);
    });
});

describe('saveAttachmentToWorkspace', () => {
    async function stored(name = 'report.pdf', content = 'bytes'): Promise<StoredAttachment> {
        seed(name, content);
        const [att] = await collectAttachmentsForSend({
            workspaceRoot: sender,
            paths: [name],
            storeRoot: blobs,
            newId: ids,
        });
        return { ...att, messageId: 'm1' };
    }

    it('defaults the destination to the attachment filename at the workspace root', async () => {
        const att = await stored();
        const r = await saveAttachmentToWorkspace({
            workspaceRoot: recipient,
            storeRoot: blobs,
            attachment: att,
        });
        expect(r.relPath).toBe('report.pdf');
        expect(fs.existsSync(path.join(recipient, 'report.pdf'))).toBe(true);
    });

    it('treats a destination that is an existing DIRECTORY as the folder to land in', async () => {
        const att = await stored();
        fs.mkdirSync(path.join(recipient, 'inbox'));

        const r = await saveAttachmentToWorkspace({
            workspaceRoot: recipient,
            storeRoot: blobs,
            attachment: att,
            destPath: 'inbox',
        });
        expect(r.relPath).toBe('inbox/report.pdf');
    });

    it('CONFINES the write to the recipient workspace', async () => {
        const att = await stored();
        await expect(
            saveAttachmentToWorkspace({
                workspaceRoot: recipient,
                storeRoot: blobs,
                attachment: att,
                destPath: '../owned.pdf',
            }),
        ).rejects.toThrow(/escapes|outside/i);
    });

    it('fails loudly when the blob is missing rather than writing an empty file', async () => {
        const att = await stored();
        fs.rmSync(blobs, { recursive: true, force: true });

        await expect(
            saveAttachmentToWorkspace({
                workspaceRoot: recipient,
                storeRoot: blobs,
                attachment: att,
                destPath: 'x.pdf',
            }),
        ).rejects.toThrow();
        expect(fs.existsSync(path.join(recipient, 'x.pdf'))).toBe(false);
    });
});
