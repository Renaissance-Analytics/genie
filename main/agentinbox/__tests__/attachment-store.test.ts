import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    ATTACHMENT_STORE_DIRNAME,
    MAX_ATTACHMENT_BYTES,
    attachmentMime,
    blobPathFor,
    isExecutableAttachmentName,
    putAttachmentBytes,
    readAttachmentBytes,
} from '../attachments';

/**
 * The CONTENT-ADDRESSED blob store behind AgentInbox attachments.
 *
 * Bytes are stored ONCE per sha256 under Genie's userData, not per message and
 * not as a path reference into the sender's workspace — the recipient may be an
 * agent in a different workspace that can't read the sender's disk at all. These
 * pin the three properties that makes that safe to run unattended: the address IS
 * the hash, identical bytes never write twice, and an oversize buffer is refused
 * before anything touches disk.
 */

let root: string;
const roots: string[] = [];

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-attach-store-'));
    roots.push(root);
});

afterAll(() => {
    for (const r of roots) {
        try {
            fs.rmSync(r, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
    }
});

/** Every regular file under `dir` (the store fans out into sharded subdirs). */
function allFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...allFiles(abs));
        else out.push(abs);
    }
    return out;
}

describe('putAttachmentBytes', () => {
    it('addresses a blob by the sha256 of its bytes and writes it there', async () => {
        const bytes = Buffer.from('hello attachment');
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');

        const r = await putAttachmentBytes(root, bytes);

        expect(r.sha256).toBe(sha);
        expect(r.bytes).toBe(bytes.length);
        expect(r.deduped).toBe(false);
        expect(fs.readFileSync(blobPathFor(root, sha))).toEqual(bytes);
    });

    it('DEDUPLICATES — identical bytes stored twice keep exactly one blob', async () => {
        const bytes = Buffer.from('the same payload, twice');

        const first = await putAttachmentBytes(root, bytes);
        const second = await putAttachmentBytes(root, bytes);

        expect(second.sha256).toBe(first.sha256);
        expect(first.deduped).toBe(false);
        expect(second.deduped).toBe(true);
        expect(allFiles(root)).toHaveLength(1);
    });

    it('keeps distinct payloads as distinct blobs', async () => {
        await putAttachmentBytes(root, Buffer.from('one'));
        await putAttachmentBytes(root, Buffer.from('two'));

        expect(allFiles(root)).toHaveLength(2);
    });

    it('REFUSES an oversize buffer, and writes nothing', async () => {
        const tooBig = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61);

        await expect(putAttachmentBytes(root, tooBig)).rejects.toThrow(/too large|size limit/i);
        expect(fs.existsSync(root) ? allFiles(root) : []).toHaveLength(0);
    });

    it('accepts a buffer exactly at the cap (the limit is inclusive)', async () => {
        const atCap = Buffer.alloc(1024, 0x62);
        const r = await putAttachmentBytes(root, atCap, { maxBytes: 1024 });
        expect(r.bytes).toBe(1024);
    });
});

describe('readAttachmentBytes', () => {
    it('round-trips the exact bytes that were stored', async () => {
        const bytes = crypto.randomBytes(4096);
        const { sha256 } = await putAttachmentBytes(root, bytes);

        expect(await readAttachmentBytes(root, sha256)).toEqual(bytes);
    });

    it('rejects an unknown hash rather than returning empty bytes', async () => {
        await expect(readAttachmentBytes(root, 'f'.repeat(64))).rejects.toThrow(
            /attachment|not found|missing/i,
        );
    });

    it('refuses a hash that is not a plain hex digest (no path traversal via the address)', async () => {
        await expect(readAttachmentBytes(root, '../../genie.db')).rejects.toThrow(/hash|digest/i);
        expect(() => blobPathFor(root, '../../genie.db')).toThrow(/hash|digest/i);
    });
});

describe('attachment naming policy', () => {
    it('names the store directory once, so host + tests agree on where blobs live', () => {
        expect(ATTACHMENT_STORE_DIRNAME).toBe('agentinbox-attachments');
    });

    it('flags natively-executable file types, whatever the case', () => {
        for (const name of ['setup.exe', 'Setup.EXE', 'a.msi', 'x.bat', 'y.cmd', 'z.ps1', 'q.vbs']) {
            expect(isExecutableAttachmentName(name), name).toBe(true);
        }
    });

    it('does NOT flag ordinary source + document types agents actually trade', () => {
        for (const name of ['notes.md', 'app.ts', 'build.sh', 'main.py', 'report.pdf', 'data.csv']) {
            expect(isExecutableAttachmentName(name), name).toBe(false);
        }
    });

    it('maps common extensions to a mime type and falls back to octet-stream', () => {
        expect(attachmentMime('a.png')).toBe('image/png');
        expect(attachmentMime('a.md')).toBe('text/markdown');
        expect(attachmentMime('a.json')).toBe('application/json');
        expect(attachmentMime('a.wat')).toBe('application/octet-stream');
    });
});
