import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
// The DEFAULT import: yazl is CommonJS, and the main bundle loads it under Node's ESM rules (cjs-named-imports.test.ts).
import yazl from 'yazl';
import { IGNORED_NAMES } from './files-host.js';

/**
 * A FOLDER, ZIPPED STRAIGHT TO A FILE (genie#1288). Export… on a folder in the Files tree; `file-export.ts` decides what may
 * be exported and where it goes, this writes the archive.
 *
 * - STREAMED: entries are added as the walk finds them and each file is opened only when the writer reaches it (yazl's
 *   `addReadStreamLazy`: one file open at a time), so a large tree never sits in memory — only the list of names the zip's
 *   central directory needs. Past 65,535 entries or 4 GiB, yazl writes the ZIP64 records itself.
 * - THE TREE'S RULE: a name in `IGNORED_NAMES` (`.git`, `node_modules`, build output…) is left out at every depth, exactly
 *   as the Files tree never lists it. Symlinks are leaves there and are never followed here: each is stored as a link
 *   (Info-ZIP's convention — the link's target as its data, `S_IFLNK` in its mode), so nothing outside the folder is read.
 * - `skip`: absolute paths never added — the archive being written and its temp file, when the person saves the zip
 *   inside the folder it zips.
 *
 * WHY YAZL: the archive must be written as it is read (large trees), and must stay valid past the classic zip's limits.
 * yazl streams with back-pressure, writes ZIP64 where needed, takes an entry's mode (links, permissions) and has one
 * dependency (buffer-crc32). fflate writes no ZIP64, so a large tree would make an archive nothing can open; archiver
 * brings its own glob walker and nine dependencies for a walk this module must do by the tree's rule anyway.
 */

const S_IFLNK = 0o120000;

export async function zipFolder(source: string, top: string, out: string, skip: readonly string[] = []): Promise<void> {
    const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
    const skipped = new Set(skip.map(norm));
    const zip = new yazl.ZipFile();
    // yazl's typings call it a NodeJS.ReadableStream; it is a stream.PassThrough, which can be destroyed.
    const output = zip.outputStream as Readable;
    // `wx`: the output name is the caller's alone — never over something that happens to be there.
    const written = pipeline(output, createWriteStream(out, { flags: 'wx' }));
    // The write failing (disk full, the folder unwritable) stops the walk at its next step rather than after the whole tree.
    let failed: unknown = null;
    written.catch((error: unknown) => { failed = error; });
    // A file that cannot be read mid-archive is emitted on the ZipFile; it ends the write, and the caller removes the part.
    zip.on('error', (error: Error) => output.destroy(error));
    try {
        const stack: Array<{ abs: string; rel: string }> = [{ abs: source, rel: top }];
        while (stack.length > 0) {
            if (failed !== null) throw failed;
            const { abs, rel } = stack.pop()!;
            const dir = await lstat(abs);
            zip.addEmptyDirectory(rel, { mtime: dir.mtime });
            const children = (await readdir(abs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            const folders: Array<{ abs: string; rel: string }> = [];
            for (const d of children) {
                if (IGNORED_NAMES.has(d.name)) continue;
                const childAbs = join(abs, d.name);
                if (skipped.has(norm(childAbs))) continue;
                const childRel = `${rel}/${d.name}`;
                if (d.isSymbolicLink()) {
                    const [info, target] = await Promise.all([lstat(childAbs), readlink(childAbs)]);
                    zip.addBuffer(Buffer.from(target, 'utf8'), childRel, { mtime: info.mtime, mode: S_IFLNK | 0o777, compress: false });
                } else if (d.isDirectory()) {
                    folders.push({ abs: childAbs, rel: childRel });
                } else if (d.isFile()) {
                    const info = await lstat(childAbs);
                    zip.addReadStreamLazy(childRel, { mtime: info.mtime, mode: info.mode }, (cb) => cb(null, createReadStream(childAbs)));
                }
                // Sockets, FIFOs and devices: the tree lists none, and they hold no file to archive.
            }
            // Depth-first, in name order: the stack takes the folders last-first.
            for (let i = folders.length - 1; i >= 0; i -= 1) stack.push(folders[i]!);
        }
        zip.end();
    } catch (error) {
        output.destroy(error instanceof Error ? error : new Error(String(error)));
        await written.catch(() => {});
        throw error;
    }
    await written;
}
