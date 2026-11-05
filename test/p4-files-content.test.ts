import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityOf, REMOTE_METHODS, type RemoteMethod } from '../src/core/remote-protocol.js';
import { FilesHost } from '../src/main/files-host.js';
import { editorRead, editorWrite } from '../src/main/plugin-editor-bytes.js';
import type { GenieBridge } from '../src/renderer/bridge.js';
import { resourceDoor } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const methods = ['files.tree', 'files.localChildren', 'files.localOpen', 'files.localReadMedia', 'files.lastCommitted', 'files.state', 'files.gitStatus', 'files.create', 'files.rename', 'files.duplicate', 'files.trash', 'files.readBytes', 'files.write', 'files.writeBytes', 'repo.call'] as const;
const tree = [{ id: 'folder', label: 'folder', type: 'folder', children: [{ id: 'folder/a.txt', label: 'a.txt', type: 'file', ext: 'txt' }] }];
const state = { files: [], activity: [], unreported: ['a.txt'], changed: null, diskChanges: [{ path: 'a.txt', at: 7 }] };
type Row = { method: typeof methods[number]; port: string; args: unknown[]; value: unknown; call: (bridge: GenieBridge) => Promise<unknown> };
const rows: Row[] = [
    { method: 'files.tree', port: 'tree', args: ['work'], value: tree, call: b => b.files.tree('work') },
    { method: 'files.localChildren', port: 'children', args: ['work', 'folder'], value: tree[0]!.children, call: b => b.files.children!('work', 'folder') },
    { method: 'files.localOpen', port: 'open', args: ['work', 'a.txt'], value: { ok: true, path: 'a.txt', text: 'exact 雪', sha: hash('exact 雪'), git: null }, call: b => b.files.open('work', 'a.txt') },
    { method: 'files.localReadMedia', port: 'readBytes', args: ['work', 'a.png'], value: { ok: true, path: 'a.png', base64: 'AAH/', sha: hash(new Uint8Array([0, 1, 255])) }, call: b => b.files.readMedia!('work', 'a.png') },
    { method: 'files.lastCommitted', port: 'lastCommitted', args: ['work', 'a.txt'], value: 'committed 雪', call: b => b.files.lastCommitted!('work', 'a.txt') },
    { method: 'files.state', port: 'state', args: ['work'], value: state, call: b => b.files.state('work') },
    { method: 'files.gitStatus', port: 'gitStatus', args: ['work'], value: { 'a.txt': 'modified' }, call: b => b.files.gitStatus!('work') },
    { method: 'files.create', port: 'create', args: ['work', 'new', 'folder'], value: { ok: true, path: 'new' }, call: b => b.files.create!('work', 'new', 'folder') },
    { method: 'files.rename', port: 'rename', args: ['work', 'a', 'b'], value: { ok: true, path: 'b' }, call: b => b.files.rename!('work', 'a', 'b') },
    { method: 'files.duplicate', port: 'duplicate', args: ['work', 'a'], value: { ok: true, path: 'a-copy' }, call: b => b.files.duplicate!('work', 'a') },
    { method: 'files.trash', port: 'trash', args: ['work', 'a'], value: { ok: true, path: 'a' }, call: b => b.files.trash!('work', 'a') },
    { method: 'files.readBytes', port: 'readBytes', args: ['work', 'a.xlsx'], value: { ok: true, path: 'a.xlsx', base64: 'AAH/', sha: hash(new Uint8Array([0, 1, 255])) }, call: b => b.files.readBytes!('work', 'sheets', 'a.xlsx') },
    { method: 'files.write', port: 'write', args: ['work', 'a.txt', 'new 雪', null], value: { ok: true, sha: hash('new 雪') }, call: b => b.files.write('work', 'a.txt', 'new 雪', null) },
    { method: 'files.writeBytes', port: 'writeBytes', args: ['work', 'a.xlsx', 'AAH/', null], value: { ok: true, sha: hash(new Uint8Array([0, 1, 255])) }, call: b => b.files.writeBytes!('work', 'sheets', 'a.xlsx', 'AAH/', null) },
    { method: 'repo.call', port: 'repo', args: ['diff', 'work', 'repos/r', 'a.txt', true], value: { ok: true, value: 'diff 雪' }, call: b => b.repo!.call('diff', 'work', 'repos/r', 'a.txt', true) },
];

async function fixture(override: Record<string, unknown> = {}) {
    const ports: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const row of rows) ports[row.port] ??= vi.fn(async (..._args: unknown[]) => row.value);
    Object.assign(ports, Object.fromEntries(Object.entries(override).map(([name, value]) => [name, typeof value === 'function' ? value : vi.fn(async () => value)])));
    const gate = vi.fn(() => ({ allowed: true as const }));
    const editor = { gate, files: ports };
    const localFiles = { files: () => ports, editor: () => editor, repo: ports.repo };
    const f = await resourceDoor(cleanups, {}, { localFiles });
    const c = await f.client();
    return { ...f, c, ports, gate, editor };
}

describe('7C local Files and repository content over the admitted door', () => {
    it.each(methods)('%s is an explicit local method', method => { expect(REMOTE_METHODS).toContain(method); expect(capabilityOf(method as RemoteMethod)).toBe('local'); });
    it.each(rows)('$method records native business arguments and returns the exact native shape', async row => {
        const f = await fixture({ [row.port]: row.value });
        expect(await row.call(f.c.bridge)).toEqual(row.value);
        expect(f.ports[row.port]).toHaveBeenCalledExactlyOnceWith(...row.args);
        expect(f.invoke.mock.calls.some(([m]) => String(m) === row.method)).toBe(true);
        if (row.method.includes('Bytes')) expect(f.gate).toHaveBeenCalledWith('sheets', 'a.xlsx');
        expect(f.c.state().connected).toBe(true);
        expect(f.serialized.every(text => Buffer.byteLength(text) <= 1024 * 1024)).toBe(true);
    });
    it.each(['tailnet', 'relay owner', 'workspace guest', 'host guest', 'readonly', 'phone'])('%s is refused before every local business call', async kind => {
        const f = await fixture(), raw = kind === 'tailnet' || kind === 'phone' ? await f.raw('tailnet', kind === 'phone') : await f.raw({ kind: 'relay', label: kind, isOwner: kind === 'relay owner', workspaceId: kind === 'workspace guest' ? 'work' : null, readonly: kind === 'readonly' });
        f.invoke.mockClear();
        for (const method of methods) expect(await raw.call(method, [])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringContaining('own Genie window') });
        expect(f.invoke).not.toHaveBeenCalled();
    });
    it.each(['tree', 'children', 'lastCommitted', 'state'])('%s keeps null instead of a default', async port => {
        const f = await fixture({ [port]: null }), row = rows.find(row => row.port === port)!;
        expect(await row.call(f.c.bridge)).toBeNull();
    });
    it('complete text/media/editor reads and committed text use bounded blobs on the same connection', async () => {
        const text = '雪'.repeat(700_000), bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0xa5), base64 = bytes.toString('base64');
        const f = await fixture({ open: { ok: true, path: 'a.txt', text, sha: hash(text), git: null }, readBytes: { ok: true, path: 'a.png', base64, sha: hash(bytes) }, lastCommitted: text });
        expect(await f.c.bridge.files.open('work', 'a.txt')).toEqual({ ok: true, path: 'a.txt', text, sha: hash(text), git: null });
        expect(await f.c.bridge.files.readMedia!('work', 'a.png')).toEqual({ ok: true, path: 'a.png', base64, sha: hash(bytes) });
        expect(await f.c.bridge.files.readBytes!('work', 'sheets', 'a.xlsx')).toEqual({ ok: true, path: 'a.png', base64, sha: hash(bytes) });
        expect(await f.c.bridge.files.lastCommitted!('work', 'a.txt')).toBe(text);
        expect(f.calls.filter(c => c.method === 'blob.open').length).toBeGreaterThanOrEqual(4);
        expect(f.calls.filter(c => c.method === 'blob.open').every(c => c.args[0] === 'workspace-file' && /^[A-Za-z0-9_-]{1,128}$/.test(String(c.args[1])))).toBe(true);
        expect(Math.max(...f.serialized.map(s => Buffer.byteLength(s)))).toBeLessThanOrEqual(1024 * 1024);
        expect(await f.c.bridge.files.tree('work')).toEqual(tree);
    });
    it('pages complete root/children listings by count and UTF-8 bytes and reassembles nested children', async () => {
        const nodes = Array.from({ length: 301 }, (_, i) => ({ id: `folder-${i}`, label: `${i}-${'雪'.repeat(2400)}`, type: 'folder', children: [{ id: `folder-${i}/a.txt`, label: 'a.txt', type: 'file', ext: 'txt' }] }));
        const f = await fixture({ tree: nodes, children: nodes.map(({ children: _children, ...node }) => node) });
        expect(await f.c.bridge.files.tree('work')).toEqual(nodes);
        expect(await f.c.bridge.files.children!('work', '')).toEqual(nodes.map(({ children: _children, ...node }) => node));
        expect(f.calls.filter(c => c.method === 'page.open').length).toBeGreaterThanOrEqual(2);
        expect(f.calls.filter(c => c.method === 'page.next').length).toBeGreaterThanOrEqual(4);
        expect(Math.max(...f.serialized.map(s => Buffer.byteLength(s)))).toBeLessThanOrEqual(1024 * 1024);
        expect(f.serialized.some(s => { const m = JSON.parse(s); return m.kind === 'result' && Array.isArray(m.value?.items) && m.value.items.length > 0; })).toBe(true);
    });
    it('stages a 2 MiB text write and keeps the complete changed-on-disk conflict', async () => {
        const mine = '雪'.repeat(700_000), theirs = 'their content '.repeat(180_000), conflict = { ok: false, reason: 'changed on disk', conflict: { path: 'a.txt', onDisk: theirs, sha: hash(theirs) } };
        const f = await fixture({ write: conflict });
        expect(await f.c.bridge.files.write('work', 'a.txt', mine, 'old-sha')).toEqual(conflict);
        expect(f.ports.write).toHaveBeenCalledExactlyOnceWith('work', 'a.txt', mine, 'old-sha');
        expect(f.calls.find(c => c.method === 'localUpload.begin')?.args).toEqual([{ purpose: 'file-write', subtype: 'text', size: Buffer.byteLength(mine) }]);
        expect(f.calls.filter(c => c.method === 'localUpload.chunk').length).toBeGreaterThan(1);
        expect(f.calls.some(c => c.method === 'blob.open')).toBe(true);
        expect(Math.max(...f.serialized.map(s => Buffer.byteLength(s)))).toBeLessThanOrEqual(1024 * 1024);
        expect(f.c.state().connected).toBe(true);
    });
    it('stages complete editor bytes and preserves the plugin gate before any file write', async () => {
        const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 0x91), base64 = bytes.toString('base64');
        const f = await fixture();
        await f.c.bridge.files.writeBytes!('work', 'sheets', 'a.xlsx', base64, null);
        expect(f.ports.writeBytes).toHaveBeenCalledExactlyOnceWith('work', 'a.xlsx', base64, null);
        expect(f.calls.find(c => c.method === 'localUpload.begin')?.args).toEqual([{ purpose: 'file-write', subtype: 'bytes', size: bytes.length }]);
        f.gate.mockReturnValue({ allowed: false, reason: 'plugin disabled or type not declared' } as never); f.ports.readBytes!.mockClear(); f.ports.writeBytes!.mockClear();
        expect(await f.c.bridge.files.readBytes!('work', 'sheets', 'a.xlsx')).toEqual(await editorRead(f.editor as never, 'work', 'sheets', 'a.xlsx'));
        expect(await f.c.bridge.files.writeBytes!('work', 'sheets', 'a.xlsx', base64, null)).toEqual(await editorWrite(f.editor as never, 'work', 'sheets', 'a.xlsx', base64, null));
        expect(f.ports.readBytes).not.toHaveBeenCalled(); expect(f.ports.writeBytes).not.toHaveBeenCalled();
    });
    it('preserves real workspace confinement, unknown-workspace values, no overwrite, and expected SHA', async () => {
        const root = await mkdtemp(join(tmpdir(), 'genie-p4-files-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
        await writeFile(join(root, 'a.txt'), 'on disk');
        const host = new FilesHost({ workspace: id => id === 'work' ? { id, path: root } : null, agentsOf: () => [], eventsOf: () => [], gitShowHead: async () => null });
        const f = await resourceDoor(cleanups, {}, { localFiles: { files: () => host, editor: () => ({ files: host, gate: () => ({ allowed: true }) }), repo: async () => ({ ok: false, error: 'fixture' }) } }), c = await f.client();
        for (const id of ['work', 'missing']) for (const path of ['a.txt', '../outside']) {
            expect(await c.bridge.files.open(id, path)).toEqual(await host.open(id, path));
            expect(await c.bridge.files.readMedia!(id, path)).toEqual(await host.readBytes(id, path));
            expect(await c.bridge.files.lastCommitted!(id, path)).toEqual(await host.lastCommitted(id, path));
        }
        expect(await c.bridge.files.write('work', 'a.txt', 'mine', null)).toEqual(await host.write('work', 'a.txt', 'mine', null));
        expect(await c.bridge.files.write('work', 'a.txt', 'mine', 'stale')).toEqual(await host.write('work', 'a.txt', 'mine', 'stale'));
        expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('on disk');
        expect(await c.bridge.files.write('work', 'a.txt', 'mine', hash('on disk'))).toEqual({ ok: true, sha: hash('mine') });
        expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('mine');
        expect(await c.bridge.files.create!('work', 'a.txt', 'file')).toMatchObject({ ok: false });
    });
    it('removes all fifteen moved native paths and retains watch and window ports', () => {
        const main = readFileSync('src/main/main.ts', 'utf8'), preload = readFileSync('src/main/preload.ts', 'utf8'), inventory = readFileSync('src/core/ipc-inventory.ts', 'utf8');
        for (const name of ['files-tree', 'files-children', 'files-open', 'files-read-media', 'files-last-committed', 'files-state', 'files-git-status', 'files-create', 'files-rename', 'files-duplicate', 'files-trash', 'files-read-bytes', 'files-write', 'files-write-bytes', 'repo']) {
            expect(main).not.toContain(`ipcMain.handle('genie:${name}'`); expect(preload).not.toContain(`ipcRenderer.invoke('genie:${name}'`); expect(inventory).not.toContain(`['genie:${name}',`);
        }
        for (const name of ['files-watch', 'files-unwatch', 'files-open-external', 'files-reveal', 'files-export', 'files-popout']) expect(main).toContain(`ipcMain.handle('genie:${name}'`);
        for (const name of ['files-changed', 'files-git']) expect(preload).toContain(`ipcRenderer.on('genie:${name}'`);
    });
});
