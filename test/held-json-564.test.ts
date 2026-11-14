import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOB_READ_BYTES } from '../src/core/local-blobs.js';
import { MAX_OPEN_PAGES } from '../src/core/local-content.js';
import { FILES_INLINE_BYTES } from '../src/core/local-files.js';
import { LocalFilesContent } from '../src/main/local-files-content.js';

const contents: LocalFilesContent[] = [];
const content = () => { const value = new LocalFilesContent(); contents.push(value); return value; };
afterEach(() => { for (const value of contents.splice(0)) value.dispose(); vi.restoreAllMocks(); });
interface Held { jsonContent: { ref: string; blob: string } }
const held = (value: unknown): Held => {
    expect(value).toMatchObject({ jsonContent: { ref: expect.any(String), blob: expect.any(String) } });
    return value as Held;
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function exactBytesAndRelease(owner: LocalFilesContent, result: Held, value: unknown) {
    const expected = Buffer.from(JSON.stringify(value), 'utf8');
    const { ref, blob } = result.jsonContent;
    const opened = await owner.blobs.open('features-json', blob);
    expect(opened.size).toBe(expected.length); expect(opened.sha256).toBe(sha(expected));
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < opened.size; offset += BLOB_READ_BYTES) {
        const part = await owner.blobs.read(opened.id, offset, Math.min(BLOB_READ_BYTES, opened.size - offset));
        chunks.push(Buffer.from(part.base64, 'base64'));
    }
    const actual = Buffer.concat(chunks);
    expect(actual.equals(expected)).toBe(true); expect(sha(actual)).toBe(opened.sha256);
    expect(JSON.parse(actual.toString('utf8'))).toEqual(value);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(FILES_INLINE_BYTES);
    expect(owner.release(ref)).toEqual({ released: true });
    expect(owner.release(ref)).toEqual({ released: false });
    await expect(owner.blobs.read(opened.id, 0, 1)).rejects.toThrow(/no such open blob/);
    await expect(owner.blobs.open('features-json', blob)).rejects.toThrow();
    expect(await owner.blobs.close(opened.id)).toEqual({ closed: false });
}

// Count the JSON representation (quotes included), rather than assuming character count equals byte count.
const boundaryCases = [
    { label: 'ASCII', unit: 'x' }, { label: 'two-byte UTF-8', unit: 'é' },
    { label: 'astral UTF-8', unit: String.fromCodePoint(0x1f9ea) },
    { label: 'escaped lone surrogate', unit: String.fromCharCode(0xd800) },
].flatMap(({ label, unit }) => [-1, 0, 1].map(delta => {
    const target = FILES_INLINE_BYTES + delta;
    const unitBytes = Buffer.from(JSON.stringify(unit)).length - 2;
    const value = unit.repeat(Math.floor((target - 2) / unitBytes)) + 'a'.repeat((target - 2) % unitBytes);
    return { label: `${label}, ${delta < 0 ? 'under' : delta === 0 ? 'at' : 'over'} the cap`, target, value };
}));

describe('held JSON keeps its content contract while avoiding unnecessary sizing (Tynn #564)', () => {
    it.each(boundaryCases)('$label keeps exact inline/blob selection, bytes, hash and release', async ({ value, target }) => {
        expect(Buffer.from(JSON.stringify(value)).length).toBe(target);
        const owner = content(), result = owner.jsonResult(value, 'boundary fixture');
        if (target <= FILES_INLINE_BYTES) {
            expect(result).toBe(value);
            expect(Buffer.from(JSON.stringify(result)).length).toBe(target);
        } else await exactBytesAndRelease(owner, held(result), value);
    });

    it.each([
        { label: 'ASCII', value: 'x'.repeat(FILES_INLINE_BYTES) },
        { label: 'multi-byte', value: 'é'.repeat(FILES_INLINE_BYTES) },
    ])('$label known-oversized JSON skips the full byte-length scan', async ({ value }) => {
        const json = JSON.stringify(value); expect(json.length).toBeGreaterThan(FILES_INLINE_BYTES);
        const owner = content(), sizing = vi.spyOn(Buffer, 'byteLength'); // Calls through to the real implementation.
        const result = held(owner.jsonResult(value, 'large fixture'));
        // This is the optimization's RED: the old code scans the entire string even though it cannot be inline.
        expect(sizing.mock.calls.filter(([input]) => input === json)).toHaveLength(0);
        await exactBytesAndRelease(owner, result, value);
    });

    it('CONTROL: UTF-16 under the cap but UTF-8 over it still uses exact byte sizing and a lossless blob', async () => {
        const value = 'é'.repeat(FILES_INLINE_BYTES / 2), json = JSON.stringify(value);
        expect(json.length).toBeLessThan(FILES_INLINE_BYTES); expect(Buffer.from(json).length).toBeGreaterThan(FILES_INLINE_BYTES);
        const owner = content(), sizing = vi.spyOn(Buffer, 'byteLength');
        const result = held(owner.jsonResult(value, 'UTF-8 boundary fixture'));
        expect(sizing.mock.calls.filter(([input]) => input === json)).toHaveLength(1);
        await exactBytesAndRelease(owner, result, value);
    });

    it('CONTROL: the held-response cap and release of an already opened blob are unchanged', async () => {
        const owner = content(), value = 'x'.repeat(FILES_INLINE_BYTES);
        const responses = Array.from({ length: MAX_OPEN_PAGES }, () => held(owner.jsonResult(value, 'budget fixture')));
        const first = responses[0]!;
        const opened = await owner.blobs.open('features-json', first.jsonContent.blob);
        expect(() => owner.jsonResult(value, 'one more fixture')).toThrow(`only ${MAX_OPEN_PAGES} lists or responses`);
        expect(owner.release(first.jsonContent.ref)).toEqual({ released: true });
        await expect(owner.blobs.read(opened.id, 0, 1)).rejects.toThrow(/no such open blob/);
        await expect(owner.blobs.open('features-json', first.jsonContent.blob)).rejects.toThrow();
        const replacement = held(owner.jsonResult(value, 'released slot fixture'));
        await exactBytesAndRelease(owner, replacement, value);
        // Releasing the first snapshot did not release any of the others.
        expect((await owner.blobs.open('features-json', responses[1]!.jsonContent.blob)).sha256).toBe(sha(Buffer.from(JSON.stringify(value))));
    });

    it('CONTROL: byte reads retain their cap and content remains exact across multiple chunks', async () => {
        const owner = content(), value = 'x'.repeat(BLOB_READ_BYTES + 17);
        const result = held(owner.jsonResult(value, 'chunk fixture'));
        const opened = await owner.blobs.open('features-json', result.jsonContent.blob);
        await expect(owner.blobs.read(opened.id, 0, BLOB_READ_BYTES + 1)).rejects.toThrow(`at most ${BLOB_READ_BYTES} bytes`);
        await owner.blobs.close(opened.id);
        await exactBytesAndRelease(owner, result, value);
    });

    it('CONTROL: small values retain the original object without allocating an encoded blob', () => {
        const owner = content(), value = { rows: ['small fixture'], none: null };
        const encode = vi.spyOn(Buffer, 'from');
        expect(owner.jsonResult(value, 'inline fixture')).toBe(value);
        expect(owner.jsonResult(undefined, 'undefined fixture')).toBeUndefined();
        expect(owner.jsonResult(null, 'null fixture')).toBeNull();
        expect(encode.mock.calls.filter(([input]) => input === JSON.stringify(value))).toHaveLength(0);
    });

    it('CONTROL: the shared terminal encoder keeps its own envelope, byte hash and release', async () => {
        const owner = content(), value = { rows: ['é'.repeat(FILES_INLINE_BYTES)] };
        const result = owner.terminalResult(value) as { terminalContent: { ref: string; blob: string } };
        expect(result).toMatchObject({ terminalContent: { ref: expect.any(String), blob: expect.any(String) } });
        expect(result).not.toHaveProperty('jsonContent');
        const expected = Buffer.from(JSON.stringify(value));
        const opened = await owner.blobs.open('terminal-json', result.terminalContent.blob);
        expect(opened.size).toBe(expected.length); expect(opened.sha256).toBe(sha(expected));
        const bytes = await owner.blobs.read(opened.id, 0, opened.size);
        expect(Buffer.from(bytes.base64, 'base64').equals(expected)).toBe(true);
        expect(owner.release(result.terminalContent.ref)).toEqual({ released: true });
        await expect(owner.blobs.read(opened.id, 0, 1)).rejects.toThrow(/no such open blob/);
        await expect(owner.blobs.open('terminal-json', result.terminalContent.blob)).rejects.toThrow();
    });
});
