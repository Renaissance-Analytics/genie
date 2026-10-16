import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from '../src/main/store.js';

/**
 * CONCURRENT ATOMIC WRITES TO ONE FILE NEVER REJECT AND NEVER CORRUPT. The Windows VM run of the
 * first-boot fixes (2026-10-11 22:11) passed 1515/1515 tests and still exited 1: an unhandled
 * `EPERM: rename attention.json.tmp -> attention.json` from the AttentionStore — two flushes in
 * flight shared ONE temp name, and on Windows a rename onto a file another handle holds is refused.
 * Every store flushes through this one helper, so the rule lives here: writes to the same file are
 * serialised, each uses its own temp name, and a transient EPERM/EBUSY on the rename is retried.
 */
describe('writeJsonAtomic', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-atomic-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

    it('25 overlapping writes to one file all resolve, the file is whole, and it holds the LAST write', async () => {
        const file = join(dir, 'runtime', 'attention.json');
        const writes = Array.from({ length: 25 }, (_, i) => writeJsonAtomic(file, { i, payload: 'x'.repeat(2048) }));
        await expect(Promise.all(writes)).resolves.toBeDefined();
        const parsed = JSON.parse(await readFile(file, 'utf8')) as { i: number };
        expect(parsed.i).toBe(24);
    });

    it('leaves no temp file behind', async () => {
        const file = join(dir, 'a.json');
        await Promise.all([writeJsonAtomic(file, 1), writeJsonAtomic(file, 2), writeJsonAtomic(file, 3)]);
        const { readdir } = await import('node:fs/promises');
        expect((await readdir(dir)).filter((n) => n.includes('.tmp'))).toEqual([]);
        expect(JSON.parse(await readFile(file, 'utf8'))).toBe(3);
    });

    it('CONTROL: two different files write independently and both land', async () => {
        await Promise.all([writeJsonAtomic(join(dir, 'x.json'), 'x'), writeJsonAtomic(join(dir, 'y.json'), 'y')]);
        expect(JSON.parse(await readFile(join(dir, 'x.json'), 'utf8'))).toBe('x');
        expect(JSON.parse(await readFile(join(dir, 'y.json'), 'utf8'))).toBe('y');
    });
});
