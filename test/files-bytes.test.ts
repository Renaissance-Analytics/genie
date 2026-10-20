import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesHost } from '../src/main/files-host.js';

/**
 * THE BYTES A PLUGIN EDITOR OPENS AND SAVES (beta.33 item 14; Genie 1's editor-bridge.ts + fs-bridge.ts). The text `open`
 * reads UTF-8, which mangles a .xlsx / .pptx / .docx; a plugin editor needs the file's BYTES. Same rules as the text path:
 * confined to the workspace, the size cap, and a save only against the sha that was read — a file that changed underneath
 * is a CONFLICT, never an overwrite. Your save is yours in Changed, never an unreported `?`.
 */

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const BIN = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0x0a]);

let root: string;
let host: FilesHost;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-files-bytes-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'q3.xlsx'), BIN);
    host = new FilesHost({ workspace: (id) => (id === 'tynn' ? { id: 'tynn', path: root } : null), agentsOf: () => [], eventsOf: () => [], sizeCap: 64 });
});
afterEach(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });

describe('FilesHost.readBytes / writeBytes', () => {
    it('reads the exact bytes (base64) with their sha — not a UTF-8 decode', async () => {
        const r = await host.readBytes('tynn', 'docs/q3.xlsx');
        expect(r).toEqual({ ok: true, path: 'docs/q3.xlsx', base64: BIN.toString('base64'), sha: sha(BIN) });
    });

    it('refuses outside the workspace, an unknown workspace, and a file over the cap — in words', async () => {
        expect(await host.readBytes('tynn', '../etc/passwd')).toMatchObject({ ok: false, error: expect.stringMatching(/outside the workspace/) });
        expect(await host.readBytes('nope', 'docs/q3.xlsx')).toMatchObject({ ok: false, error: 'no such workspace' });
        await writeFile(join(root, 'big.xlsx'), Buffer.alloc(100));
        expect(await host.readBytes('tynn', 'big.xlsx')).toMatchObject({ ok: false, error: expect.stringMatching(/Genie will not open it/) });
    });

    it('a save against the sha that was read lands, byte for byte, and is yours in Changed', async () => {
        const next = Buffer.from([1, 2, 3, 250]);
        const r = await host.writeBytes('tynn', 'docs/q3.xlsx', next.toString('base64'), sha(BIN));
        expect(r).toEqual({ ok: true, sha: sha(next) });
        expect(Buffer.compare(await readFile(join(root, 'docs', 'q3.xlsx')), next)).toBe(0);
        expect((await host.state('tynn'))!.changed).toEqual([{ who: 'you', files: ['docs/q3.xlsx'] }]);
    });

    it('a file that changed since it was read is a CONFLICT and nothing is overwritten', async () => {
        const theirs = Buffer.from([9, 9, 9]);
        await writeFile(join(root, 'docs', 'q3.xlsx'), theirs);
        const r = await host.writeBytes('tynn', 'docs/q3.xlsx', Buffer.from([1]).toString('base64'), sha(BIN));
        expect(r).toMatchObject({ ok: false, conflict: { path: 'docs/q3.xlsx', sha: sha(theirs) } });
        expect(Buffer.compare(await readFile(join(root, 'docs', 'q3.xlsx')), theirs)).toBe(0);
    });

    it('refuses to write outside the workspace', async () => {
        expect(await host.writeBytes('tynn', '../x.xlsx', 'AA==', null)).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the workspace/) });
    });
});

describe('the plugin gate in front of the bytes (main.ts IPC)', () => {
    const gate = (pluginId: string, path: string) => (pluginId === 'ai.genie.spreadsheet' && path.endsWith('.xlsx') ? { allowed: true as const } : { allowed: false as const, reason: `${pluginId} may not open ${path}` });

    it('reads and writes only through an enabled plugin\'s own claimed type; anything else is refused before the disk is touched', async () => {
        const { editorRead, editorWrite } = await import('../src/main/plugin-editor-bytes.js');
        const deps = { gate, files: host };
        expect(await editorRead(deps, 'tynn', 'ai.genie.spreadsheet', 'docs/q3.xlsx')).toMatchObject({ ok: true, base64: BIN.toString('base64') });
        expect(await editorRead(deps, 'tynn', 'ai.genie.document', 'docs/q3.xlsx')).toEqual({ ok: false, path: 'docs/q3.xlsx', error: 'ai.genie.document may not open docs/q3.xlsx' });
        expect(await editorWrite(deps, 'tynn', 'ai.genie.document', 'docs/q3.xlsx', 'AA==', sha(BIN))).toEqual({ ok: false, reason: 'ai.genie.document may not open docs/q3.xlsx' });
        expect(Buffer.compare(await readFile(join(root, 'docs', 'q3.xlsx')), BIN)).toBe(0);
        expect(await editorWrite(deps, 'tynn', 'ai.genie.spreadsheet', 'docs/q3.xlsx', 'AA==', sha(BIN))).toMatchObject({ ok: true });
    });

    it('bad arguments are refused in words, not thrown', async () => {
        const { editorRead, editorWrite } = await import('../src/main/plugin-editor-bytes.js');
        expect(await editorRead({ gate, files: host }, 'tynn', 42 as never, 'x')).toMatchObject({ ok: false, error: 'bad arguments' });
        expect(await editorWrite({ gate, files: host }, 'tynn', 'ai.genie.spreadsheet', 'docs/q3.xlsx', null as never, null)).toMatchObject({ ok: false, reason: 'bad arguments' });
    });
});
