import { afterEach, expect, it, vi } from 'vitest';
import { resourceDoor } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture() {
    const repo = vi.fn(async (..._args: unknown[]) => ({ ok: true, value: null }));
    const f = await resourceDoor(cleanups, {}, { localFiles: { files: () => null, editor: () => null, repo } });
    return { ...f, repo, c: await f.client() };
}
it('repo-args is a host-bound 100 MiB subtype, and only repo.call consumes it', async () => {
    const f = await fixture(), raw = await f.raw();
    const begun = await raw.call('localUpload.begin', [{ purpose: 'file-write', subtype: 'repo-args', size: 2 }]);
    expect(begun).toMatchObject({ kind: 'result', ok: true, value: { size: 2 } });
    const id = (begun as { value: { id: string } }).value.id;
    expect(await raw.call('localUpload.chunk', [id, 0, 'W10='])).toMatchObject({ kind: 'result', ok: true });
    f.invoke.mockClear();
    for (const [method, args] of [
        ['files.write', ['work', 'a.txt', { staged: id }, null]],
        ['files.writeBytes', ['work', 'editor', 'a.xlsx', { staged: id }, null]],
    ] as const) expect(await raw.call(method, [...args])).toMatchObject({ kind: 'result', ok: false });
    expect(f.invoke).not.toHaveBeenCalled();
    // A wrong consumer did not steal it: repo.call now takes it, then rejects its malformed argument array.
    expect(await raw.call('repo.call', [{ staged: id }])).toMatchObject({ kind: 'result', ok: false });
    expect(await raw.call('localUpload.abort', [id])).toMatchObject({ kind: 'result', ok: true, value: { aborted: false } });
    expect(f.repo).not.toHaveBeenCalled();
    expect(await raw.call('localUpload.begin', [{ purpose: 'file-write', subtype: 'repo-args', size: 100 * 1024 * 1024 + 1 }])).toMatchObject({ kind: 'result', ok: false });
});
it('complete large repo arguments use their own subtype and preserve native call arguments', async () => {
    const f = await fixture(), paths = Array.from({ length: 1800 }, (_, i) => `${i}/${'雪'.repeat(180)}.txt`);
    expect(await f.c.bridge.repo!.call('stage', 'work', 'repos/r', paths, true)).toEqual({ ok: true, value: null });
    expect(f.repo).toHaveBeenCalledExactlyOnceWith('stage', 'work', 'repos/r', paths, true);
    const input = f.calls.find(c => c.method === 'localUpload.begin')?.args[0];
    expect(input).toMatchObject({ purpose: 'file-write', subtype: 'repo-args' });
    expect(f.calls.filter(c => c.method === 'localUpload.chunk').length).toBeGreaterThan(1);
    expect(Math.max(...f.serialized.map(s => Buffer.byteLength(s)))).toBeLessThanOrEqual(1024 * 1024);
});
it('repo.call refuses text/bytes stages without consuming them or invoking native git', async () => {
    const f = await fixture(), raw = await f.raw();
    for (const subtype of ['text', 'bytes']) {
        const stage = await raw.call('localUpload.begin', [{ purpose: 'file-write', subtype, size: 0 }]);
        const id = (stage as { value: { id: string } }).value.id;
        f.invoke.mockClear();
        expect(await raw.call('repo.call', [{ staged: id }])).toMatchObject({ kind: 'result', ok: false });
        expect(f.invoke).not.toHaveBeenCalled();
        expect(await raw.call('localUpload.abort', [id])).toMatchObject({ kind: 'result', ok: true, value: { aborted: true } });
    }
    expect(f.repo).not.toHaveBeenCalled();
});
