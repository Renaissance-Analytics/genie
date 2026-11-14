import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { linuxRow, linuxRows, linuxSh } from './helpers/ci-scripts.js';
import { touchedZip64, zipWriters } from '../scripts/zip64-paths.mjs';

/**
 * THE ZIP64 CHECK IS WIRED. A tree past 65,535 entries, exported and read back, took 172-320 s of a 208-350 s Linux suite, so it left `npm test` for `npm run verify:zip64`: on the pattern of the
 * Flows acceptance suite, a CI job that always reports and runs it when a change touches the writer, and in the release gate. This file is what keeps a wrong filter from skipping it silently:
 * it runs in the default suite, against real paths.
 */
const code = (yaml: string) => yaml.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const release = code(read('.github/workflows/release.yml'));
const repo = fileURLToPath(new URL('..', import.meta.url));

describe('the check itself', () => {
    it('`npm run verify:zip64` runs its own config, over its own files', () => {
        const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
        expect(pkg.scripts['verify:zip64']).toBe('vitest run -c vitest.zip64.config.mts');
        expect(read('vitest.zip64.config.mts')).toContain("include: ['test/zip64-acceptance/**/*.accept.ts']");
    });

    it('the large tree lives there and nowhere else, and it is still past the limit it is about', () => {
        const check = read('test/zip64-acceptance/large-tree.accept.ts');
        expect(check).toContain('a large tree');
        const perDir = Number(/const perDir = (\d+);/.exec(check)?.[1]);
        const dirs = Number(/const dirs = (\d+);/.exec(check)?.[1]);
        expect(perDir * dirs).toBeGreaterThan(65_535);
        expect(read('test/folder-export.test.ts')).not.toContain('a large tree');
        // CONTROL: the rest of the folder export is still in the default suite.
        expect(read('test/folder-export.test.ts')).toContain('a symlink is stored as a link');
        // The default run takes `*.test.*`, so this name stays out of it.
        expect(read('vite.config.ts')).toContain("include: ['test/**/*.test.{ts,tsx}']");
    });
});

describe('the Linux gate', () => {
    it('runs it in its own row (scripts/ci/linux.sh), and only there', () => {
        expect(linuxRows).toContain('zip64');
        expect(linuxRow('zip64')).toMatch(/npm run verify:zip64/);
        expect(linuxSh.match(/npm run verify:zip64/g)).toHaveLength(1);
    });
});

describe('what counts as touching the writer', () => {
    it('the writer, the check, its config and the script that decides, and a change to the writer when it has been deleted', () => {
        for (const path of ['src/main/folder-zip.ts', 'test/zip64-acceptance/large-tree.accept.ts', 'test/zip64-acceptance/gone.accept.ts', 'vitest.zip64.config.mts', 'scripts/zip64-paths.mjs']) {
            expect(touchedZip64([path]), path).toEqual([path]);
        }
    });

    it('not the rest of Genie (CONTROL: a filter that matched everything would pass the test above)', () => {
        expect(touchedZip64(['README.md', 'src/main/file-export.ts', 'src/main/terminal-host.ts', 'test/folder-export.test.ts', 'package.json', ''])).toEqual([]);
    });

    it('the writer is found by what imports yazl, on this commit, so one that moves or a second one joins by itself', () => {
        expect(read('src/main/folder-zip.ts')).toMatch(/^import yazl from 'yazl';/m);
        expect(zipWriters()).toContain('src/main/folder-zip.ts');
        expect(existsSync(join(repo, 'src/main/folder-zip.ts'))).toBe(true);
        const root = mkdtempSync(join(tmpdir(), 'zip64-paths-'));
        try {
            mkdirSync(join(root, 'src', 'main'), { recursive: true });
            writeFileSync(join(root, 'src', 'main', 'another-zip.ts'), "import { ZipFile } from 'yazl';\n");
            writeFileSync(join(root, 'src', 'main', 'unrelated.ts'), "import { join } from 'node:path';\n// a comment about yazl\n");
            expect(zipWriters(root)).toEqual(['src/main/another-zip.ts']);
            expect(touchedZip64(['src/main/another-zip.ts', 'src/main/unrelated.ts'], root)).toEqual(['src/main/another-zip.ts']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('`--touched <file>` prints the paths that touch it, one per line, and nothing when none do', () => {
        const dir = mkdtempSync(join(tmpdir(), 'zip64-paths-'));
        try {
            const list = join(dir, 'changed.txt');
            const touched = (paths: string[]) => {
                writeFileSync(list, `${paths.join('\n')}\n`);
                return execFileSync(process.execPath, ['scripts/zip64-paths.mjs', '--touched', list], { cwd: repo, encoding: 'utf8' });
            };
            expect(touched(['README.md', 'src/main/folder-zip.ts'])).toBe('src/main/folder-zip.ts\n');
            expect(touched(['README.md', 'src/main/terminal-host.ts'])).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the release', () => {
    it('runs no tests: the gate before a tag is the local CI (the owner, 2026-11-11)', () => {
        expect(release).not.toMatch(/npm run verify:zip64/);
        expect(release).not.toMatch(/run: npm test\b/);
        expect(release).toMatch(/run: npm run build\b/);
    });
});
