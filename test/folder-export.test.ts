import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open as openZip, type Entry } from 'yauzl';
import { FILE_SIZE_CAP } from '../src/core/files-panel.js';
import { fileExporter, type SaveDialog } from '../src/main/file-export.js';
import { FilesHost, IGNORED_NAMES } from '../src/main/files-host.js';

/**
 * EXPORT A FOLDER AS A .ZIP (genie#1288; the owner approved it 2026-10-27 for the next build, on top of #1264's file export).
 *
 * - MAIN streams the zip straight to the path the OS save dialog answered; nothing crosses into the renderer but a path or a
 *   reason, and no file is held in memory whole.
 * - Large trees work: past 65,535 entries a zip needs ZIP64 records, and the archive still opens with every entry in it.
 * - What the tree never shows, the zip never holds: the Files tree's own rule (`IGNORED_NAMES`, at every depth), and
 *   symlinks are leaves, never followed — stored as links, so nothing outside the workspace rides along.
 * - The same confinement as file export, and only a person starts it (the dialog; see file-export.test.ts).
 *
 * Genie 1 had no export at all, so there is nothing to port.
 */

type ZipEntry = { readonly dir: boolean; readonly link: boolean; readonly data: Buffer };

/** Every entry in a zip, by name — read with yauzl, an independent reader (the writer is yazl). */
function readZip(path: string): Promise<Map<string, ZipEntry>> {
    return new Promise((resolve, reject) => {
        openZip(path, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
            if (error || !zip) return reject(error ?? new Error('no zip'));
            const out = new Map<string, ZipEntry>();
            zip.on('error', reject);
            zip.on('end', () => resolve(out));
            zip.on('entry', (entry: Entry) => {
                const type = (entry.externalFileAttributes >>> 16) & 0o170000;
                if (entry.fileName.endsWith('/')) { out.set(entry.fileName, { dir: true, link: false, data: Buffer.alloc(0) }); zip.readEntry(); return; }
                zip.openReadStream(entry, (e, stream) => {
                    if (e || !stream) return reject(e ?? new Error('no stream'));
                    const chunks: Buffer[] = [];
                    stream.on('data', (c: Buffer) => chunks.push(c));
                    stream.on('error', reject);
                    stream.on('end', () => { out.set(entry.fileName, { dir: false, link: type === 0o120000, data: Buffer.concat(chunks) }); zip.readEntry(); });
                });
            });
            zip.readEntry();
        });
    });
}

describe('fileExporter — a folder exports as a .zip, streamed by main', () => {
    let root: string;
    let downloads: string;
    let elsewhere: string;
    let host: FilesHost;
    let asked: Array<Parameters<SaveDialog>[0]>;
    let answer: (opts: Parameters<SaveDialog>[0]) => Promise<{ canceled: boolean; filePath?: string }>;
    const dialog: SaveDialog = (opts) => { asked.push(opts); return answer(opts); };
    const make = () => fileExporter({ files: host, saveDialog: dialog, downloads: () => downloads });
    const files = (zip: Map<string, ZipEntry>) => [...zip.entries()].filter(([, e]) => !e.dir).map(([n]) => n).sort();

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'genie2-zip-ws-'));
        downloads = await mkdtemp(join(tmpdir(), 'genie2-zip-dl-'));
        elsewhere = await mkdtemp(join(tmpdir(), 'genie2-zip-else-'));
        await mkdir(join(root, 'src', 'lib'), { recursive: true });
        await mkdir(join(root, 'src', 'empty'));
        await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
        await writeFile(join(root, 'src', 'lib', 'b.ts'), 'export const b = 2;\n');
        host = new FilesHost({ workspace: (id: string) => (id === 'tynn' ? { id: 'tynn', path: root } : null), agentsOf: () => [], eventsOf: () => [] });
        asked = [];
        answer = async () => ({ canceled: true });
    });
    afterEach(async () => {
        for (const d of [root, downloads, elsewhere]) await rm(d, { recursive: true, force: true });
    }, 120_000);

    it('the dialog suggests <folder>.zip in Downloads and offers zip; the zip holds the folder, its files byte-for-byte and its empty folders', async () => {
        const dest = join(elsewhere, 'mine.zip');
        answer = async () => ({ canceled: false, filePath: dest });
        const r = await make().export('tynn', 'src');
        expect(r).toEqual({ ok: true, path: dest });
        expect(asked).toHaveLength(1);
        expect(asked[0]!.defaultPath).toBe(join(downloads, 'src.zip'));
        expect(asked[0]!.filters).toEqual([{ name: 'Zip archive', extensions: ['zip'] }]);
        const zip = await readZip(dest);
        expect(files(zip)).toEqual(['src/a.ts', 'src/lib/b.ts']);
        expect(zip.get('src/a.ts')!.data.toString('utf8')).toBe('export const a = 1;\n');
        expect(zip.get('src/lib/b.ts')!.data.toString('utf8')).toBe('export const b = 2;\n');
        expect(zip.get('src/empty/')?.dir).toBe(true);
    });

    it('a nested folder exports under its own name; a binary over the editor’s size cap arrives whole', async () => {
        const bytes = randomBytes(FILE_SIZE_CAP + 1024 * 1024 + 7);
        await writeFile(join(root, 'src', 'lib', 'big.bin'), bytes);
        const dest = join(elsewhere, 'lib.zip');
        answer = async () => ({ canceled: false, filePath: dest });
        const r = await make().export('tynn', 'src/lib');
        // Only a path crosses back to the renderer — never the archive's bytes.
        expect(Object.keys(r).sort()).toEqual(['ok', 'path']);
        const zip = await readZip(dest);
        expect(files(zip)).toEqual(['lib/b.ts', 'lib/big.bin']);
        expect(zip.get('lib/big.bin')!.data.equals(bytes)).toBe(true);
    });

    it('leaves out exactly what the Files tree leaves out, at every depth (CONTROL: look-alike names are kept)', async () => {
        // Every ignored name, one level down: the OS litter as files, the rest as folders with a file in them.
        for (const name of IGNORED_NAMES) {
            if (name === '.DS_Store' || name === 'Thumbs.db') { await writeFile(join(root, 'src', 'lib', name), 'x'); continue; }
            await mkdir(join(root, 'src', 'lib', name));
            await writeFile(join(root, 'src', 'lib', name, 'inside.txt'), 'x');
        }
        await mkdir(join(root, 'src', '.git', 'objects'), { recursive: true });
        await writeFile(join(root, 'src', '.git', 'HEAD'), 'ref: refs/heads/main\n');
        await mkdir(join(root, 'src', 'node_modules', 'left-pad'), { recursive: true });
        await writeFile(join(root, 'src', 'node_modules', 'left-pad', 'index.js'), 'x');
        // CONTROL: the rule matches whole names, not prefixes or extensions.
        await writeFile(join(root, 'src', 'node_modules.txt'), 'kept');
        await mkdir(join(root, 'src', 'distribution'));
        await writeFile(join(root, 'src', 'distribution', 'kept.txt'), 'kept');

        const dest = join(elsewhere, 'src.zip');
        answer = async () => ({ canceled: false, filePath: dest });
        expect((await make().export('tynn', 'src')).ok).toBe(true);
        const names = [...(await readZip(dest)).keys()];
        for (const n of names) {
            const segments = n.split('/').filter((s) => s !== '');
            expect(segments.filter((s) => IGNORED_NAMES.has(s)), n).toEqual([]);
        }
        expect(names).toContain('src/node_modules.txt');
        expect(names).toContain('src/distribution/kept.txt');

        // The zip's files are exactly the files the tree lists when every folder is opened.
        const treeFiles: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            for (const n of (await host.children('tynn', dir)) ?? []) {
                if (n.type === 'folder') await walk(n.id);
                else treeFiles.push(n.id);
            }
        };
        await walk('src');
        expect(files(await readZip(dest))).toEqual(treeFiles.sort());
    });

    // Not on Windows: making 66,000 files there took 5 minutes on genie-test-windows (6.5 s on omarchy-test), and what this
    // proves — ZIP64 records past 65,535 entries — does not depend on the platform. The Windows run covers the paths.
    it.skipIf(process.platform === 'win32')('a large tree — past the 65,535 entries a plain zip can count — exports every file (ZIP64)', async () => {
        const perDir = 1000;
        const dirs = 66;
        for (let d = 0; d < dirs; d += 1) {
            const dir = join(root, 'src', 'many', `d${d}`);
            await mkdir(dir, { recursive: true });
            await Promise.all(Array.from({ length: perDir }, (_, i) => writeFile(join(dir, `f${i}.txt`), `${d}/${i}`)));
        }
        const dest = join(elsewhere, 'many.zip');
        answer = async () => ({ canceled: false, filePath: dest });
        expect((await make().export('tynn', 'src/many')).ok).toBe(true);
        const zip = await readZip(dest);
        expect(files(zip)).toHaveLength(dirs * perDir);
        expect(zip.get('many/d65/f999.txt')!.data.toString('utf8')).toBe('65/999');
    }, 600_000);

    it('a symlink is stored as a link, never followed: nothing outside the workspace rides along', async () => {
        await writeFile(join(elsewhere, 'secret.txt'), 'outside');
        // A junction needs no privilege on Windows; elsewhere the type is ignored and this is a symlink.
        await symlink(elsewhere, join(root, 'src', 'outside'), 'junction');
        const dest = join(downloads, 'src.zip');
        answer = async () => ({ canceled: false, filePath: dest });
        expect((await make().export('tynn', 'src')).ok).toBe(true);
        const zip = await readZip(dest);
        expect([...zip.keys()].filter((n) => n.startsWith('src/outside/'))).toEqual([]);
        expect(zip.get('src/outside')?.link).toBe(true);
        // The entry carries where the link points, not what is there.
        expect(zip.get('src/outside')!.data.toString('utf8')).not.toBe('');
        expect(zip.get('src/outside')!.data.toString('utf8')).not.toBe('outside');
        // CONTROL: the rest of the folder is there.
        expect(files(zip)).toContain('src/a.ts');
    });

    it('a zip saved INSIDE the folder it zips does not swallow itself or its temp file', async () => {
        const dest = join(root, 'src', 'src.zip');
        answer = async () => ({ canceled: false, filePath: dest });
        expect((await make().export('tynn', 'src')).ok).toBe(true);
        const names = files(await readZip(dest));
        expect(names).toEqual(['src/a.ts', 'src/lib/b.ts']);
        expect((await readdir(join(root, 'src'))).sort()).toEqual(['a.ts', 'empty', 'lib', 'src.zip']);
    });

    it('overwrites a zip the person chose to replace (the OS dialog asked)', async () => {
        const dest = join(elsewhere, 'src.zip');
        await writeFile(dest, 'old');
        answer = async () => ({ canceled: false, filePath: dest });
        expect((await make().export('tynn', 'src')).ok).toBe(true);
        expect(files(await readZip(dest))).toEqual(['src/a.ts', 'src/lib/b.ts']);
    });

    it('a failed export says why in words, leaves the chosen file as it was, and leaves no partial behind', async () => {
        const dest = join(elsewhere, 'src.zip');
        await writeFile(dest, 'keep me');
        // The folder goes away while the dialog is open.
        answer = async () => { await rm(join(root, 'src'), { recursive: true, force: true }); return { canceled: false, filePath: dest }; };
        const r = await make().export('tynn', 'src');
        expect(r.ok).toBe(false);
        expect('reason' in r ? r.reason : '').toMatch(/src/);
        expect(await readFile(dest, 'utf8')).toBe('keep me');
        expect(await readdir(elsewhere)).toEqual(['src.zip']);
    });

    it('cancel writes nothing', async () => {
        answer = async () => ({ canceled: true });
        expect(await make().export('tynn', 'src')).toEqual({ ok: false, canceled: true });
        expect(await readdir(elsewhere)).toEqual([]);
        expect(await readdir(downloads)).toEqual([]);
    });

    it('the workspace root is not exported (empty space offers no Export…), and nothing outside it either — before any dialog', async () => {
        for (const path of ['', '.', '..', elsewhere]) {
            const r = await make().export('tynn', path);
            expect(r.ok, path).toBe(false);
        }
        expect(asked).toEqual([]);
    });
});
