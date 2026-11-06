import { afterEach, expect, it, vi } from 'vitest';
import { invokeLocalFiles, type LocalFilesDeps } from '../src/main/local-files-api.js';
import { repoCall } from '../src/main/official-panels-host.js';
import { resourceDoor } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture() {
    const ports = { tree: vi.fn(async () => []), children: vi.fn(async () => []), open: vi.fn(async () => ({ ok: true, path: 'a', text: 'value', sha: 'sha' })), readBytes: vi.fn(async () => ({ ok: true, path: 'a.xlsx', base64: '', sha: 'sha' })), lastCommitted: vi.fn(async () => null), state: vi.fn(() => null), gitStatus: vi.fn(async () => ({})), create: vi.fn(async () => ({ ok: true, path: 'a' })), rename: vi.fn(async () => ({ ok: true, path: 'a' })), duplicate: vi.fn(async () => ({ ok: true, path: 'a' })), trash: vi.fn(async () => ({ ok: true, path: 'a' })), write: vi.fn(async (..._args: unknown[]) => ({ ok: true, sha: 'sha' })), writeBytes: vi.fn(async (..._args: unknown[]) => ({ ok: true, sha: 'sha' })) };
    const deps = { files: () => ports, editor: () => ({ files: ports, gate: () => ({ allowed: true }) }), repo: (op: unknown, id: unknown, rel: unknown, a: unknown, b: unknown) => repoCall({ workspacePath: id => id === 'work' ? 'synthetic-root-never-used-by-invalid-op' : null, send: async () => {}, now: () => 'fixture' }, op, id, rel, a, b) } as unknown as LocalFilesDeps;
    const f = await resourceDoor(cleanups, {}, { localFiles: deps }); return { ...f, deps, ports, c: await f.client() };
}
const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
const invalid = [null, undefined, 7, 7n, cyclic];
it.each(invalid.map((value, index) => ({ value, index })))('invalid value$index keeps native validation and a live connection', async ({ value }) => {
    const f = await fixture(), b = f.c.bridge as any;
    const rows: Array<[string, unknown[], () => Promise<unknown>]> = [
        ['files.tree', [value], () => b.files.tree(value)],
        ['files.localChildren', ['work', value], () => b.files.children('work', value)],
        ['files.localOpen', ['work', value], () => b.files.open('work', value)],
        ['files.localReadMedia', ['work', value], () => b.files.readMedia('work', value)],
        ['files.lastCommitted', ['work', value], () => b.files.lastCommitted('work', value)],
        ['files.state', [value], () => b.files.state(value)],
        ['files.gitStatus', [value], () => b.files.gitStatus(value)],
        ['files.create', ['work', 'a', value], () => b.files.create('work', 'a', value)],
        ['files.rename', ['work', 'a', value], () => b.files.rename('work', 'a', value)],
        ['files.duplicate', ['work', value], () => b.files.duplicate('work', value)],
        ['files.trash', ['work', value], () => b.files.trash('work', value)],
        ['files.readBytes', ['work', value, 'a.xlsx'], () => b.files.readBytes('work', value, 'a.xlsx')],
        ['files.write', ['work', 'a', value, null], () => b.files.write('work', 'a', value, null)],
        ['files.writeBytes', ['work', 'sheets', 'a.xlsx', value, null], () => b.files.writeBytes('work', 'sheets', 'a.xlsx', value, null)],
        ['repo.call', [value, 'work', '', null, null], () => b.repo.call(value, 'work', '', null, null)],
    ];
    for (const [method, args, call] of rows) expect(await call(), method).toEqual(await invokeLocalFiles(f.deps, method as never, args));
    expect(f.c.state().connected).toBe(true);
    expect(await b.files.tree('work')).toEqual([]);
});
it('non-string SHA becomes null before JSON, as both retired native writers did', async () => {
    const f = await fixture(), b = f.c.bridge as any;
    for (const value of [7n, cyclic]) {
        expect(await b.files.write('work', 'a', 'new', value)).toEqual({ ok: true, sha: 'sha' });
        expect(f.ports.write).toHaveBeenLastCalledWith('work', 'a', 'new', null);
        expect(await b.files.writeBytes('work', 'sheets', 'a.xlsx', '', value)).toEqual({ ok: true, sha: 'sha' });
        expect(f.ports.writeBytes).toHaveBeenLastCalledWith('work', 'a.xlsx', '', null);
    }
    expect(f.c.state().connected).toBe(true);
});
