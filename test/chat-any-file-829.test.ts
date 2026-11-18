import { describe, expect, it } from 'vitest';
import { attachmentKind, promptContent, type Attachment } from '../src/core/prompt-content.js';
import { safeUploadName, savedFileNote, uploadsDirFor, uploadTypeOf } from '../src/core/chat-uploads.js';

/**
 * ANY FILE CAN BE SENT TO AN AGENT (Tynn #829; the owner, beta.64). A .docx letterhead attached in the composer was
 * refused at Send: "Wish's Wonders Letterhead.docx is neither an image nor a text file, so it cannot be sent to an agent".
 *
 * Images and text files still go inline. Anything else is saved by the HOST into the agent's workspace at
 * `.ai/_dirty/uploads/<date>/<safe name>` (main/chat-uploads.ts) and the message tells the agent the path, the type and
 * the size, so it opens the file with its own tools. These are the pure halves: what kind a file is, what the agent is
 * told, and what name and folder a file gets.
 */
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const MB = 1024 * 1024;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
/** A .docx is a zip: `PK\x03\x04`, then binary. */
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0x00, 0x00, 0x21, 0x00, 0xff, 0xfe]);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const all = { image: true, textResource: true };
const LETTERHEAD = "Wish's Wonders Letterhead.docx";

describe('what kind a file is', () => {
    it('an image by its bytes, a text file by its bytes, anything else a file to save; an image over 5 MB is saved too', () => {
        const bigPng = new Uint8Array(5 * MB + 1);
        bigPng.set(PNG);
        expect([
            attachmentKind({ name: 'shot.png', type: 'image/png', bytes: PNG }),
            attachmentKind({ name: 'notes.md', type: '', bytes: enc('# Notes') }),
            attachmentKind({ name: LETTERHEAD, type: DOCX_TYPE, bytes: DOCX }),
            attachmentKind({ name: 'huge.png', type: 'image/png', bytes: bigPng }),
        ]).toEqual(['image', 'text', 'file', 'file']);
    });
});

describe('what the agent is told about a saved file', () => {
    it('the docx the owner attached is SENT: the text, then a note with its workspace path, type and size', () => {
        const saved: Attachment = { name: LETTERHEAD, type: DOCX_TYPE, bytes: new Uint8Array(0), saved: { path: `.ai/_dirty/uploads/2026-11-17/${LETTERHEAD}`, type: DOCX_TYPE, size: 52 * 1024 } };
        const r = promptContent('use this as the letterhead', [saved], all, b64);
        expect(r.ok).toBe(true);
        if (!r.ok || typeof r.content === 'string') return;
        expect(r.names).toEqual([LETTERHEAD]);
        expect(r.content.map((c) => c.type)).toEqual(['text', 'text']);
        const note = (r.content[1] as { text: string }).text;
        expect(note).toContain(`.ai/_dirty/uploads/2026-11-17/${LETTERHEAD}`);
        expect(note).toContain(DOCX_TYPE);
        expect(note).toContain('52 KB');
    });

    it('a file that was NOT saved is refused with a reason that says so, never the old "neither an image nor a text file"', () => {
        const r = promptContent('hi', [{ name: LETTERHEAD, type: DOCX_TYPE, bytes: DOCX }], all, b64);
        expect(r.ok).toBe(false);
        const reason = r.ok ? '' : r.reason;
        expect(reason).toContain(LETTERHEAD);
        expect(reason).toMatch(/not saved into the workspace/);
        expect(reason).not.toMatch(/neither an image nor a text file/);
    });

    it('a saved file keeps the 25 MB limit: its saved size counts, not the emptied bytes', () => {
        const r = promptContent('hi', [{ name: 'big.zip', type: 'application/zip', bytes: new Uint8Array(0), saved: { path: '.ai/_dirty/uploads/2026-11-17/big.zip', type: 'application/zip', size: 26 * MB } }], all, b64);
        expect(r.ok ? 'sent' : r.reason).toMatch(/25 MB/);
    });

    it('CONTROL: an image and a text file still go inline, exactly as before', () => {
        const r = promptContent('look', [{ name: 'shot.png', type: 'image/png', bytes: PNG }, { name: 'a.txt', type: 'text/plain', bytes: enc('x') }], all, b64);
        expect(r.ok && Array.isArray(r.content) ? r.content.map((c) => c.type) : r).toEqual(['text', 'image', 'resource']);
    });

    it('the note reads plainly on its own', () => {
        expect(savedFileNote('report.pdf', { path: '.ai/_dirty/uploads/2026-11-17/report.pdf', type: 'application/pdf', size: 3 * MB })).toBe(
            'Attached file report.pdf: saved in this workspace at .ai/_dirty/uploads/2026-11-17/report.pdf (application/pdf, 3.0 MB). Open it from there with your own tools.',
        );
    });
});

describe('the name and the folder a saved file gets', () => {
    it('a name is a base name with nothing that leaves the folder, nothing Windows refuses, and never empty', () => {
        const cases: Array<[string, string]> = [
            [LETTERHEAD, LETTERHEAD],
            ['../../etc/passwd', 'passwd'],
            ['..\\..\\Windows\\evil.docx', 'evil.docx'],
            ['C:\\Users\\x\\report.pdf', 'report.pdf'],
            ['bad<>:"|?*name.pdf', 'badname.pdf'],
            ['tab\there\u0000.txt', 'tabhere.txt'],
            ['CON.txt', '_CON.txt'],
            ['nul', '_nul'],
            ['com1.docx', '_com1.docx'],
            ['trailing. . ', 'trailing'],
            ['.hidden', 'hidden'],
            ['..', 'file'],
            ['', 'file'],
            ['///', 'file'],
        ];
        const wrong = cases.filter(([given, want]) => safeUploadName(given) !== want).map(([given, want]) => `${JSON.stringify(given)} -> ${JSON.stringify(safeUploadName(given))}, want ${JSON.stringify(want)}`);
        expect(wrong).toEqual([]);
    });

    it('a very long name is cut to 150 characters and keeps its extension', () => {
        const name = safeUploadName(`${'a'.repeat(300)}.docx`);
        expect(name.length).toBe(150);
        expect(name.endsWith('.docx')).toBe(true);
    });

    it('the folder is .ai/_dirty/uploads/<local date>', () => {
        expect(uploadsDirFor(new Date(2026, 10, 7, 23, 59))).toBe('.ai/_dirty/uploads/2026-11-07');
    });

    it('the type is what the picker said, else what the extension names, else octet-stream', () => {
        expect([uploadTypeOf('a.pdf', 'application/pdf'), uploadTypeOf('a.docx', ''), uploadTypeOf('a.xlsx', 'application/octet-stream'), uploadTypeOf('a.zip', ''), uploadTypeOf('a.weird', '')]).toEqual([
            'application/pdf',
            DOCX_TYPE,
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/zip',
            'application/octet-stream',
        ]);
    });
});
