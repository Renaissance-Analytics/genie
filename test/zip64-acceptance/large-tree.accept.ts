import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fileExporter } from '../../src/main/file-export.js';
import { FilesHost } from '../../src/main/files-host.js';
import { readZip } from '../helpers/read-zip.js';

/**
 * PAST 65,535 ENTRIES A ZIP NEEDS ZIP64 RECORDS, AND THE ARCHIVE STILL OPENS WITH EVERY ENTRY IN IT (genie#1288). Out of `npm test`: see vitest.zip64.config.mts. The rest of the folder export is
 * test/folder-export.test.ts.
 */
let root: string;
let elsewhere: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-zip-ws-'));
    elsewhere = await mkdtemp(join(tmpdir(), 'genie2-zip-else-'));
});
afterEach(async () => {
    for (const d of [root, elsewhere]) await rm(d, { recursive: true, force: true });
}, 120_000);

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
    const host = new FilesHost({ workspace: (id: string) => (id === 'tynn' ? { id: 'tynn', path: root } : null), agentsOf: () => [], eventsOf: () => [] });
    const exporter = fileExporter({ files: host, saveDialog: async () => ({ canceled: false, filePath: dest }), downloads: () => elsewhere });
    expect((await exporter.export('tynn', 'src/many')).ok).toBe(true);
    const zip = await readZip(dest);
    expect([...zip.entries()].filter(([, e]) => !e.dir)).toHaveLength(dirs * perDir);
    expect(zip.get('many/d65/f999.txt')!.data.toString('utf8')).toBe('65/999');
}, 600_000);
