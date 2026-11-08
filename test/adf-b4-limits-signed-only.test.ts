import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PACKAGE_LIMITS, PACKAGE_SIGNATURE_FILE, packageLimitProblem } from '../src/core/plugin-integrity.js';
import { renderSdkDocs } from '../src/core/sdk-docs.js';
import { readPackageFiles } from '../src/main/plugin-package.js';

/**
 * THE LIMITS COUNT THE SIGNED FILES ONLY (the coordinator's ruling, 2026-11-08, matching the Tynn marketplace's upload
 * check, C2). genie-package/1's file count and total size are over the files the digest covers: `genie-plugin.sig` at the
 * package root is not one of them, so it is not counted. Found by tynn-slave: Genie counted it, so a package of exactly
 * 10,000 signed files plus its signature was refused here and accepted by Tynn. The digest was always the same.
 *
 * The 50 MB a file cap still bounds the signature file: it is the only thing that stops Genie reading an outsized one.
 */
const MB = 1024 * 1024;
const signed = (n: number, size = 1) => Array.from({ length: n }, (_, i) => ({ path: `f/${i}.txt`, size }));
const sig = { path: PACKAGE_SIGNATURE_FILE, size: 88 };

describe('the count and the total are over the signed files', () => {
    it('10,000 signed files and the signature: accepted; 10,001 signed: refused', () => {
        expect(packageLimitProblem([...signed(10_000), sig])).toBeNull();
        expect(packageLimitProblem([...signed(10_001), sig])).toMatch(/10,001 files.*at most 10,000/);
    });

    it('200 MB of signed files and the signature: accepted; one signed byte more: refused', () => {
        const atLimit = Array.from({ length: 5 }, (_, i) => ({ path: `part${i}.bin`, size: 40 * MB }));
        expect(packageLimitProblem([...atLimit, sig])).toBeNull();
        expect(packageLimitProblem([...atLimit, { path: 'one-more', size: 1 }, sig])).toMatch(/at most 200 MB in all/);
    });

    it('only the ROOT signature file is left out: one of that name deeper in is a signed file, and counts', () => {
        expect(packageLimitProblem([...signed(10_000), sig, { path: `lib/${PACKAGE_SIGNATURE_FILE}`, size: 1 }])).toMatch(/10,001 files/);
    });

    it('the signature file is still held to 50 MB a file, so an outsized one is never read', () => {
        expect(packageLimitProblem([...signed(1), { path: PACKAGE_SIGNATURE_FILE, size: PACKAGE_LIMITS.fileBytes + 1 }])).toMatch(/genie-plugin\.sig is .* at most 50 MB a file/);
    });
});

describe('a real package folder at the boundary', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-b4-limits-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('exactly 10,000 signed files plus genie-plugin.sig is read, not refused', async () => {
        await mkdir(join(dir, 'f'), { recursive: true });
        for (let start = 0; start < 10_000; start += 500) {
            await Promise.all(Array.from({ length: 500 }, (_, k) => writeFile(join(dir, 'f', `${start + k}.txt`), 'x')));
        }
        await writeFile(join(dir, PACKAGE_SIGNATURE_FILE), 'c2lnbmF0dXJl');
        const r = await readPackageFiles(dir);
        expect(r.ok, r.ok ? '' : r.reason).toBe(true);
        if (r.ok) expect(r.files).toHaveLength(10_001);
        // CONTROL: one signed file more is refused, with the count of signed files.
        await writeFile(join(dir, 'f', 'one-more.txt'), 'x');
        const over = await readPackageFiles(dir);
        expect(over.ok).toBe(false);
        if (!over.ok) expect(over.reason).toMatch(/10,001 files/);
    }, 120_000);
});

describe('docs/sdk/packages.md says so', () => {
    it('the limits are over the signed files; the signature file is not counted', () => {
        const page = renderSdkDocs().get('packages.md')!;
        expect(page).toMatch(/limits count the signed files only/i);
        expect(page).toMatch(/`genie-plugin\.sig` is not counted/);
    });
});
