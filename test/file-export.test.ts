import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileMenuItems } from '../src/core/file-menu.js';
import { FILE_SIZE_CAP } from '../src/core/files-panel.js';
import { REMOTE_METHODS } from '../src/core/remote-protocol.js';
import { fileExporter, type SaveDialog } from '../src/main/file-export.js';
import { FilesHost } from '../src/main/files-host.js';

/**
 * EXPORT… — SAVE A WORKSPACE FILE TO A PLACE ON THIS MACHINE (genie#1264; the owner, 2026-10-27: "Our file browser needs a
 * real export, for saving a file to a new location locally").
 *
 * Genie 1 (v0.7.0-beta.342) had no export in its file browser: FileTreeContextMenu.tsx offers New file / New folder /
 * Copy relative path / Rename / Duplicate / Delete, and no `showSaveDialog` exists anywhere in it. Its only "save a file
 * here" was the AgentInbox attachment download (AgentInboxFlyout.tsx `download`), which read the bytes into the renderer
 * as base64 and clicked an `<a download>`. Genie 2 does better: MAIN opens the OS save dialog and streams the file to the
 * chosen path, so the bytes never cross into the renderer and a binary or large file exports whole. The dialog starts in
 * the folder the last export went to, else Downloads (Genie 1's main/dialog-start-dir.ts: the last place, for the session).
 * Files only — Genie 1 exported nothing, folders included.
 */

describe('fileMenuItems — Export… on a file and on an editor tab', () => {
    const ids = (t: Parameters<typeof fileMenuItems>[0], a: Parameters<typeof fileMenuItems>[1]) => fileMenuItems(t, a).map((i) => i.id);
    const all = { external: true, reveal: true, export: true };

    it('a file in the tree: its own group after the host’s app / file manager', () => {
        expect(ids('tree-file', all)).toEqual(['open-external', 'reveal', '-', 'export', '-', 'copy-path', 'copy-relative-path']);
    });

    it('an editor tab (the editor’s menu)', () => {
        expect(ids('tab', all)).toEqual(['open-external', 'reveal', '-', 'export', '-', 'copy-path', 'copy-relative-path', '-', 'close', 'close-others', 'close-all']);
    });

    it('a folder and empty space offer none (Genie 1 exported nothing; folders are not in scope)', () => {
        expect(ids('tree-folder', all)).not.toContain('export');
        expect(ids('tree-root', all)).not.toContain('export');
    });

    it('does not hang on the host’s screen: offered where open-external and reveal are not', () => {
        expect(ids('tree-file', { external: false, reveal: false, export: true })[0]).toBe('export');
    });

    it('without an export on the bridge, no item (CONTROL)', () => {
        expect(ids('tree-file', { external: true, reveal: true })).not.toContain('export');
    });

    it('the label says a dialog follows', () => {
        expect(fileMenuItems('tree-file', all).find((i) => i.id === 'export')?.label).toBe('Export…');
    });
});

describe('fileExporter — main opens the save dialog and streams the file', () => {
    let root: string;
    let downloads: string;
    let elsewhere: string;
    let host: FilesHost;
    let asked: Array<Parameters<SaveDialog>[0]>;
    let answer: (opts: Parameters<SaveDialog>[0]) => Promise<{ canceled: boolean; filePath?: string }>;
    const dialog: SaveDialog = (opts) => { asked.push(opts); return answer(opts); };
    const make = () => fileExporter({ files: host, saveDialog: dialog, downloads: () => downloads });

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'genie2-export-ws-'));
        downloads = await mkdtemp(join(tmpdir(), 'genie2-export-dl-'));
        elsewhere = await mkdtemp(join(tmpdir(), 'genie2-export-else-'));
        await mkdir(join(root, 'src'));
        await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
        host = new FilesHost({ workspace: (id: string) => (id === 'tynn' ? { id: 'tynn', path: root } : null), agentsOf: () => [], eventsOf: () => [] });
        asked = [];
        answer = async () => ({ canceled: true });
    });
    afterEach(async () => {
        for (const d of [root, downloads, elsewhere]) await rm(d, { recursive: true, force: true });
    });

    it('the dialog suggests the file’s name in Downloads; the file lands where the person chose', async () => {
        const dest = join(elsewhere, 'a-export.ts');
        answer = async () => ({ canceled: false, filePath: dest });
        const r = await make().export('tynn', 'src/a.ts');
        expect(r).toEqual({ ok: true, path: dest });
        expect(asked).toHaveLength(1);
        expect(asked[0]!.defaultPath).toBe(join(downloads, 'a.ts'));
        expect(await readFile(dest, 'utf8')).toBe('export const a = 1;\n');
    });

    it('a binary file larger than the editor’s size cap exports byte-for-byte (streamed, never through the renderer)', async () => {
        const bytes = randomBytes(FILE_SIZE_CAP + 1024 * 1024 + 7);
        await writeFile(join(root, 'big.bin'), bytes);
        const dest = join(elsewhere, 'big.bin');
        answer = async () => ({ canceled: false, filePath: dest });
        const r = await make().export('tynn', 'big.bin');
        expect(r.ok).toBe(true);
        // What crosses back to the renderer is a path or a reason — never the file's bytes or text.
        expect(Object.keys(r).sort()).toEqual(['ok', 'path']);
        expect((await readFile(dest)).equals(bytes)).toBe(true);
    });

    it('the next export starts in the folder the last one went to (CONTROL: the first started in Downloads)', async () => {
        const exporter = make();
        answer = async () => ({ canceled: false, filePath: join(elsewhere, 'one.ts') });
        await exporter.export('tynn', 'src/a.ts');
        await exporter.export('tynn', 'src/a.ts');
        expect(asked[0]!.defaultPath).toBe(join(downloads, 'a.ts'));
        expect(asked[1]!.defaultPath).toBe(join(elsewhere, 'a.ts'));
    });

    it('cancel writes nothing and says nothing went wrong', async () => {
        answer = async () => ({ canceled: true });
        expect(await make().export('tynn', 'src/a.ts')).toEqual({ ok: false, canceled: true });
        expect(await readdir(elsewhere)).toEqual([]);
        expect(await readdir(downloads)).toEqual([]);
    });

    it('overwrites a file the person chose to replace (the OS dialog asked)', async () => {
        const dest = join(elsewhere, 'a.ts');
        await writeFile(dest, 'old');
        answer = async () => ({ canceled: false, filePath: dest });
        expect((await make().export('tynn', 'src/a.ts')).ok).toBe(true);
        expect(await readFile(dest, 'utf8')).toBe('export const a = 1;\n');
    });

    it('a failed copy says why in words, leaves the chosen file as it was, and leaves no partial file behind', async () => {
        const dest = join(elsewhere, 'a.ts');
        await writeFile(dest, 'keep me');
        // The source goes away while the dialog is open: the read fails after the person chose.
        answer = async () => { await rm(join(root, 'src', 'a.ts')); return { canceled: false, filePath: dest }; };
        const r = await make().export('tynn', 'src/a.ts');
        expect(r.ok).toBe(false);
        expect('reason' in r && r.reason).toMatch(/a\.ts/);
        expect(await readFile(dest, 'utf8')).toBe('keep me');
        expect(await readdir(elsewhere)).toEqual(['a.ts']);
    });

    it('a destination that cannot be written is refused in words (its folder is a file)', async () => {
        await writeFile(join(elsewhere, 'not-a-folder'), 'x');
        answer = async () => ({ canceled: false, filePath: join(elsewhere, 'not-a-folder', 'a.ts') });
        const r = await make().export('tynn', 'src/a.ts');
        expect(r.ok).toBe(false);
        expect('reason' in r ? r.reason : '').not.toBe('');
    });

    it('exporting a file onto itself leaves it whole', async () => {
        const src = join(root, 'src', 'a.ts');
        answer = async () => ({ canceled: false, filePath: src });
        expect((await make().export('tynn', 'src/a.ts')).ok).toBe(true);
        expect(await readFile(src, 'utf8')).toBe('export const a = 1;\n');
    });

    it('only files inside the workspace: outside, the root, a folder or an unknown workspace is refused BEFORE any dialog opens', async () => {
        await writeFile(join(elsewhere, 'secret.txt'), 's');
        const exporter = make();
        for (const [ws, path] of [['tynn', '../../etc/passwd'], ['tynn', join(elsewhere, 'secret.txt')], ['tynn', ''], ['tynn', 'src'], ['nope', 'src/a.ts']] as const) {
            const r = await exporter.export(ws, path);
            expect(r.ok, `${ws}:${path}`).toBe(false);
            expect('reason' in r ? r.reason : '', `${ws}:${path}`).not.toBe('');
        }
        expect(asked).toEqual([]);
    });
});

describe('export is a person’s action only', () => {
    it('no remote-protocol method exports a file: an agent or a remote caller cannot open this machine’s save dialog', () => {
        expect(REMOTE_METHODS.filter((m) => /export/i.test(m))).toEqual([]);
    });
});
