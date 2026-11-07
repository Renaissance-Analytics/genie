import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalFilesContent } from '../src/main/local-files-content.js';
import { resourceDoor } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [], restore: Array<() => void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of restore.splice(0)) fn(); for (const close of cleanups.splice(0)) await close(); });
async function codec() { const path: string = '../src/renderer/local-base64.js'; return import(path); }
function nativeApi(owner: object, key: string, value: unknown) {
    const previous = Object.getOwnPropertyDescriptor(owner, key);
    Object.defineProperty(owner, key, { configurable: true, writable: true, value });
    restore.push(() => { if (previous) Object.defineProperty(owner, key, previous); else Reflect.deleteProperty(owner, key); });
}
function fastApis() {
    const encode = vi.fn(function (this: Uint8Array) { return Buffer.from(this).toString('base64'); });
    const decode = vi.fn((text: string) => new Uint8Array(Buffer.from(text, 'base64')));
    nativeApi(Uint8Array.prototype, 'toBase64', encode); nativeApi(Uint8Array, 'fromBase64', decode);
    return { encode, decode };
}

it('local byte codecs use available native APIs without constructing binary strings', async () => {
    const { encodeLocalBase64, decodeLocalBase64 } = await codec(), fast = fastApis(), bytes = Uint8Array.from([0, 1, 255]);
    vi.spyOn(globalThis, 'btoa').mockImplementation(() => { throw new Error('binary string encoding used'); });
    vi.spyOn(globalThis, 'atob').mockImplementation(() => { throw new Error('binary string decoding used'); });
    expect(encodeLocalBase64(bytes)).toBe('AAH/'); expect(fast.encode).toHaveBeenCalledExactlyOnceWith();
    expect(Buffer.from(decodeLocalBase64('AAH/')).equals(Buffer.from(bytes))).toBe(true);
    expect(fast.decode).toHaveBeenCalledExactlyOnceWith('AAH/');
});

it('local codec fallback preserves exact bytes, padding and malformed-input refusal', async () => {
    const { encodeLocalBase64, decodeLocalBase64 } = await codec();
    nativeApi(Uint8Array.prototype, 'toBase64', undefined); nativeApi(Uint8Array, 'fromBase64', undefined);
    for (const size of [0, 1, 2, 3, 32767, 32768, 32769, 65537]) {
        const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251), expected = Buffer.from(bytes).toString('base64');
        expect(encodeLocalBase64(bytes)).toBe(expected);
        expect(Buffer.from(decodeLocalBase64(expected)).equals(Buffer.from(bytes))).toBe(true);
    }
    expect(decodeLocalBase64('%%%')).toBeNull();
});

it('a native decode exception remains a visible malformed-input refusal', async () => {
    const { decodeLocalBase64 } = await codec(); nativeApi(Uint8Array, 'fromBase64', () => { throw new SyntaxError('bad encoding'); });
    expect(decodeLocalBase64('bad')).toBeNull();
});

it('actual local media reads and staged text writes use the native byte codec on the same door', async () => {
    const fast = fastApis(), bytes = Buffer.alloc(2 * 1024 * 1024, 0x91), base64 = bytes.toString('base64'), text = '雪'.repeat(700_000);
    const write = vi.fn(async () => ({ ok: true, sha: 'saved' }));
    const f = await resourceDoor(cleanups, {}, { localFiles: { files: () => ({ readBytes: async () => ({ ok: true, path: 'image.png', base64, sha: createHash('sha256').update(bytes).digest('hex') }), write }), editor: () => null, repo: async () => null } });
    const c = await f.client();
    vi.spyOn(globalThis, 'btoa').mockImplementation(() => { throw new Error('binary string encoding used'); });
    vi.spyOn(globalThis, 'atob').mockImplementation(() => { throw new Error('binary string decoding used'); });
    expect(await c.bridge.files.readMedia!('work', 'image.png')).toMatchObject({ ok: true, base64 });
    expect(await c.bridge.files.write('work', 'a.txt', text, null)).toEqual({ ok: true, sha: 'saved' });
    expect(write).toHaveBeenCalledExactlyOnceWith('work', 'a.txt', text, null);
    expect(fast.encode).toHaveBeenCalled(); expect(fast.decode).toHaveBeenCalled(); expect(c.state().connected).toBe(true);
    expect(Math.max(...f.serialized.map(frame => Buffer.byteLength(frame)))).toBeLessThanOrEqual(1024 * 1024);
});

it('flat leaf metadata is bounded as a record without reserializing every scalar field', async () => {
    const resources = new LocalFilesContent(); cleanups.push(async () => resources.dispose());
    const nodes = Array.from({ length: 6000 }, (_, i) => ({ id: `entry-${i}`, label: `${i}-${'x'.repeat(150)}`, type: 'file', ext: 'txt' }));
    const response = resources.capture(nodes, 'workspace-tree') as { filesContent: { value: { ref: string } } };
    const stringify = vi.spyOn(JSON, 'stringify');
    const page = await resources.pages.open('workspace-tree', response.filesContent.value.ref);
    expect(page.items).toHaveLength(128); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(512 * 1024);
    expect(stringify.mock.calls.filter(([value]) => typeof value === 'string')).toHaveLength(0);
});

it('empty children do not add page round trips to a complete large native tree', async () => {
    const nodes = Array.from({ length: 6000 }, (_, i) => ({ id: `entry-${i}`, label: `${i}-${'x'.repeat(150)}`, type: 'file' }));
    const tree = [...nodes, { id: 'folder', label: 'folder', type: 'folder', children: [] }];
    const f = await resourceDoor(cleanups, {}, { localFiles: { files: () => ({ tree: async () => tree }), editor: () => null, repo: async () => null } });
    const c = await f.client(), result = await c.bridge.files.tree('work');
    expect(JSON.stringify(result)).toBe(JSON.stringify(tree));
    expect(f.calls.filter(call => call.method === 'page.open')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'page.next')).toHaveLength(46);
    expect(Math.max(...f.serialized.map(frame => Buffer.byteLength(frame)))).toBeLessThanOrEqual(1024 * 1024);
});

it('compact metadata still preserves undefined slots, long fields and special own keys', async () => {
    const leaf = Object.fromEntries([['id', 'leaf'], ['__proto__', 'own text'], ['constructor', 'own constructor'], ['optional', undefined], ['large', '雪'.repeat(700_000)]]);
    const f = await resourceDoor(cleanups, {}, { localFiles: { files: () => ({ tree: async () => [leaf] }), editor: () => null, repo: async () => null } });
    const c = await f.client(), result = await c.bridge.files.tree('work');
    expect(result).toEqual([leaf]); expect(Object.hasOwn(result![0]!, 'optional')).toBe(true);
    expect(Object.hasOwn(result![0]!, '__proto__')).toBe(true); expect(c.state().connected).toBe(true);
});
