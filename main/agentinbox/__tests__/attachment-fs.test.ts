import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    MAX_ATTACHMENT_BYTES,
    readWorkspaceAttachment,
    writeWorkspaceAttachment,
} from '../attachments';

/**
 * CAPABILITY SCOPING for attachments — the two ends of the transfer.
 *
 * A sender may only read a file inside its OWN workspace; a recipient may only
 * write inside ITS own. Both ends mirror the plugin fs bridge's containment
 * (`guardedResolve` + a size cap), because "an agent handed me a path" is exactly
 * the input that must never be able to read `~/.ssh/id_rsa` or drop a file
 * outside the workspace that asked for it.
 */

let ws: string;
const dirs: string[] = [];

beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-attach-ws-'));
    dirs.push(ws);
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

function write(rel: string, content: string | Buffer): string {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
}

describe('readWorkspaceAttachment (the SENDER side)', () => {
    it('reads a file inside the workspace and describes it', async () => {
        write('docs/notes.md', '# hi');

        const r = await readWorkspaceAttachment(ws, 'docs/notes.md');

        expect(r.filename).toBe('notes.md');
        expect(r.relPath).toBe('docs/notes.md');
        expect(r.mime).toBe('text/markdown');
        expect(r.bytes.toString('utf8')).toBe('# hi');
    });

    it('accepts an ABSOLUTE path that is still inside the workspace', async () => {
        const abs = write('a.txt', 'x');
        const r = await readWorkspaceAttachment(ws, abs);
        expect(r.relPath).toBe('a.txt');
    });

    it('DENIES a `..` escape', async () => {
        fs.writeFileSync(path.join(path.dirname(ws), 'outside.txt'), 'secret');
        await expect(readWorkspaceAttachment(ws, '../outside.txt')).rejects.toThrow(
            /escapes|outside/i,
        );
    });

    it('DENIES an absolute path outside the workspace', async () => {
        const outside = path.join(os.tmpdir(), 'genie-attach-outsider.txt');
        fs.writeFileSync(outside, 'secret');
        await expect(readWorkspaceAttachment(ws, outside)).rejects.toThrow(/escapes|outside/i);
    });

    it('DENIES the workspace root itself and a directory', async () => {
        fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
        await expect(readWorkspaceAttachment(ws, '.')).rejects.toThrow();
        await expect(readWorkspaceAttachment(ws, 'src')).rejects.toThrow(/not a file|directory/i);
    });

    it('DENIES a natively-executable file type', async () => {
        write('tool.exe', 'MZ');
        await expect(readWorkspaceAttachment(ws, 'tool.exe')).rejects.toThrow(/executable/i);
    });

    it('DENIES a file over the size cap, by STAT — never by reading it first', async () => {
        // A sparse file: `stat` reports the full length, so an oversize refusal
        // that reads before it checks would try to buffer the whole thing.
        const abs = path.join(ws, 'huge.bin');
        const fd = fs.openSync(abs, 'w');
        fs.ftruncateSync(fd, MAX_ATTACHMENT_BYTES + 1);
        fs.closeSync(fd);

        await expect(readWorkspaceAttachment(ws, 'huge.bin')).rejects.toThrow(
            /too large|size limit/i,
        );
    });

    it('reports a missing file plainly', async () => {
        await expect(readWorkspaceAttachment(ws, 'nope.txt')).rejects.toThrow();
    });
});

describe('writeWorkspaceAttachment (the RECIPIENT side)', () => {
    const bytes = Buffer.from('delivered');

    it('writes inside the workspace, creating intermediate folders', async () => {
        const r = await writeWorkspaceAttachment(ws, 'inbox/deep/report.pdf', bytes);

        expect(r.relPath).toBe('inbox/deep/report.pdf');
        expect(r.bytes).toBe(bytes.length);
        expect(fs.readFileSync(path.join(ws, 'inbox/deep/report.pdf'))).toEqual(bytes);
    });

    it('DENIES a `..` escape', async () => {
        await expect(writeWorkspaceAttachment(ws, '../escaped.txt', bytes)).rejects.toThrow(
            /escapes|outside/i,
        );
        expect(fs.existsSync(path.join(path.dirname(ws), 'escaped.txt'))).toBe(false);
    });

    it('DENIES an absolute path outside the workspace', async () => {
        const outside = path.join(os.tmpdir(), 'genie-attach-written-outside.txt');
        await expect(writeWorkspaceAttachment(ws, outside, bytes)).rejects.toThrow(
            /escapes|outside/i,
        );
        expect(fs.existsSync(outside)).toBe(false);
    });

    it('DENIES renaming a benign attachment into an executable on the way in', async () => {
        await expect(writeWorkspaceAttachment(ws, 'payload.exe', bytes)).rejects.toThrow(
            /executable/i,
        );
        expect(fs.existsSync(path.join(ws, 'payload.exe'))).toBe(false);
    });

    it('refuses to CLOBBER an existing file unless overwrite is asked for', async () => {
        write('report.pdf', 'mine');

        await expect(writeWorkspaceAttachment(ws, 'report.pdf', bytes)).rejects.toThrow(
            /already exists/i,
        );
        expect(fs.readFileSync(path.join(ws, 'report.pdf'), 'utf8')).toBe('mine');

        await writeWorkspaceAttachment(ws, 'report.pdf', bytes, { overwrite: true });
        expect(fs.readFileSync(path.join(ws, 'report.pdf'))).toEqual(bytes);
    });

    it('DENIES writing over the workspace root', async () => {
        await expect(writeWorkspaceAttachment(ws, '.', bytes)).rejects.toThrow();
    });
});
