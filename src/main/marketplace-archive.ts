import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import { PACKAGE_LIMITS, PACKAGE_SIGNATURE_FILE, packagePathProblem } from '../core/plugin-integrity.js';

export const MARKETPLACE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MIB = 1024 * 1024;

function portablePath(name: string): string {
    const problem = packagePathProblem(name);
    if (problem || /[\\:<>"|?*]/.test(name) || Buffer.byteLength(name) > PACKAGE_LIMITS.pathBytes) throw new Error(`Invalid portable package path: ${problem ?? name}`);
    for (const part of name.split('/')) {
        if (/[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)) throw new Error(`Reserved device or nonportable path: ${name}`);
    }
    // Upper then lower also folds aliases such as sharp-s and final sigma. A stricter collision refusal grants nothing.
    return name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

function zipFile(path: string): Promise<ZipFile> {
    return new Promise((resolve, reject) => openZip(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error || !zip ? reject(error ?? new Error('Invalid ZIP archive')) : resolve(zip)));
}

/** Enumerate and validate the WHOLE directory before creating an extracted file. Never shell out to an archiver. */
async function directory(zip: ZipFile, signal: AbortSignal): Promise<Entry[]> {
    return new Promise((resolve, reject) => {
        const entries: Entry[] = [];
        const paths = new Map<string, { name: string; dir: boolean; explicit: boolean }>();
        let compressed = 0, uncompressed = 0, count = 0;
        const cleanup = (): void => { zip.removeListener('error', stop); signal.removeEventListener('abort', cancel); };
        const stop = (error: unknown): void => { cleanup(); reject(error); };
        const cancel = (): void => stop(signal.reason ?? new Error('ZIP reading cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
        zip.on('error', stop);
        zip.once('end', () => {
            cleanup();
            if (uncompressed > Math.max(MIB, 200 * compressed)) reject(new Error('ZIP package expansion ratio exceeds its limit'));
            else resolve(entries);
        });
        zip.on('entry', (entry: Entry) => {
            try {
                if (entries.length >= 20_001) throw new Error('ZIP entry count exceeds its limit');
                const dir = entry.fileName.endsWith('/');
                const name = dir ? entry.fileName.slice(0, -1) : entry.fileName;
                const key = portablePath(name);
                const type = (entry.externalFileAttributes >>> 16) & 0o170000;
                if (type !== 0 && type !== (dir ? 0o040000 : 0o100000)) throw new Error(`${name} is a link or other nonregular ZIP entry type`);
                if (entry.generalPurposeBitFlag & 0x41) throw new Error('Encrypted ZIP entries are refused');
                if (![0, 8].includes(entry.compressionMethod)) throw new Error('Unsupported ZIP compression method');
                if (!Number.isSafeInteger(entry.uncompressedSize) || !Number.isSafeInteger(entry.compressedSize) || entry.uncompressedSize < 0 || entry.compressedSize < 0) throw new Error('Invalid ZIP entry size');
                const cap = name === 'genie-plugin.json' ? MIB : name === PACKAGE_SIGNATURE_FILE ? 4096 : PACKAGE_LIMITS.fileBytes;
                if (entry.uncompressedSize > cap || (dir && entry.uncompressedSize !== 0)) throw new Error(`${name} exceeds the ZIP file size limit`);
                if (entry.uncompressedSize > Math.max(MIB, 200 * entry.compressedSize)) throw new Error('ZIP expansion ratio exceeds its limit');
                const old = paths.get(key);
                if (old && (old.explicit || old.name !== name || !old.dir || !dir)) throw new Error(`Duplicate or colliding portable ZIP path: ${name}`);
                const parts = name.split('/');
                for (let i = 1; i < parts.length; i++) {
                    const parent = parts.slice(0, i).join('/'), folded = portablePath(parent);
                    const previous = paths.get(folded);
                    if (previous && (!previous.dir || previous.name !== parent)) throw new Error(`ZIP file parent or path collision: ${parent}`);
                    if (!previous) paths.set(folded, { name: parent, dir: true, explicit: false });
                }
                paths.set(key, { name, dir, explicit: true });
                entries.push(entry);
                if (!dir && name !== PACKAGE_SIGNATURE_FILE) {
                    compressed += entry.compressedSize; uncompressed += entry.uncompressedSize;
                    count++;
                    if (count > PACKAGE_LIMITS.files || uncompressed > PACKAGE_LIMITS.totalBytes) throw new Error('ZIP package file count or total size limit exceeded');
                }
                zip.readEntry();
            } catch (error) { stop(error); }
        });
        zip.readEntry();
    });
}

/** CRC is checked explicitly: yauzl validates inflated sizes but deliberately does not check CRCs. */
export async function extractMarketplaceArchive(archive: string, destination: string, signal: AbortSignal): Promise<{ fileCount: number; uncompressedSize: number }> {
    const zip = await zipFile(archive);
    // Keep a listener for late I/O errors after the directory pass; each read stream reports its own error too.
    const ignore = (): void => {};
    zip.on('error', ignore);
    const file = await open(archive, 'r');
    const abort = (): void => zip.close();
    signal.addEventListener('abort', abort, { once: true });
    let fileCount = 0, uncompressedSize = 0;
    try {
        signal.throwIfAborted();
        const entries = await directory(zip, signal);
        for (const entry of entries) {
            signal.throwIfAborted();
            // The local header may not disagree with the directory that was reviewed above.
            const header = Buffer.alloc(30);
            if ((await file.read(header, 0, 30, entry.relativeOffsetOfLocalHeader)).bytesRead !== 30 || header.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid ZIP local header');
            if ((header.readUInt16LE(6) & 0x41) || header.readUInt16LE(8) !== entry.compressionMethod) throw new Error('Encrypted or inconsistent ZIP local header');
            const nameBytes = Buffer.alloc(header.readUInt16LE(26));
            if ((await file.read(nameBytes, 0, nameBytes.length, entry.relativeOffsetOfLocalHeader + 30)).bytesRead !== nameBytes.length
                || new TextDecoder('utf-8', { fatal: true }).decode(nameBytes) !== entry.fileName) throw new Error('Inconsistent ZIP file name in local header');
            const dir = entry.fileName.endsWith('/');
            const target = join(destination, entry.fileName);
            if (dir) { await mkdir(target, { recursive: true, mode: 0o700 }); continue; }
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, input) => error || !input ? reject(error ?? new Error('Unreadable ZIP file')) : resolve(input)));
            const output = await open(target, 'wx', 0o600);
            let size = 0, checksum = 0;
            const cancel = (): void => { (stream as import('node:stream').Readable).destroy(signal.reason instanceof Error ? signal.reason : new Error('ZIP extraction cancelled')); };
            signal.addEventListener('abort', cancel, { once: true });
            try {
                for await (const data of stream as import('node:stream').Readable) {
                    signal.throwIfAborted();
                    const chunk = data as Buffer;
                    size += chunk.length;
                    if (size > entry.uncompressedSize || size > PACKAGE_LIMITS.fileBytes) throw new Error('ZIP file exceeds its declared size limit');
                    checksum = crc32(chunk, checksum);
                    await output.writeFile(chunk);
                }
                if (size !== entry.uncompressedSize) throw new Error('ZIP file length disagrees with its declared size');
                if (checksum !== entry.crc32) throw new Error('ZIP CRC checksum does not match');
            } finally { signal.removeEventListener('abort', cancel); (stream as import('node:stream').Readable).destroy(); await output.close(); }
            if (entry.fileName !== PACKAGE_SIGNATURE_FILE) { fileCount++; uncompressedSize += size; }
        }
        signal.throwIfAborted();
        return { fileCount, uncompressedSize };
    } finally { signal.removeEventListener('abort', abort); await file.close(); zip.close(); }
}
