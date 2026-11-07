import { open as openZip, type Entry } from 'yauzl';

export type ZipEntry = { readonly dir: boolean; readonly link: boolean; readonly data: Buffer };

/** Every entry in a zip, by name — read with yauzl, an independent reader (the writer is yazl). */
export function readZip(path: string): Promise<Map<string, ZipEntry>> {
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
