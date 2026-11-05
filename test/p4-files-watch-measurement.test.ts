import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());
async function helper() { const path: string = '../scripts/files-watch-measure-page.mjs'; return import(path); }
it('the watch VM helper holds exactly the requested views on the actual bridge and measures complete git data', async () => {
    const listeners: Array<(event: unknown) => void> = [], offs = [vi.fn(), vi.fn()];
    const subscribe = vi.fn((_id, _want, listener) => { listeners.push(listener); return offs[listeners.length - 1]!; });
    vi.stubGlobal('window', { genieTest: { files: { subscribe }, workspaces: { settings: vi.fn(async () => ({ ok: true })) } } });
    const { measureFilesWatchPage } = await helper();
    expect(await measureFilesWatchPage({ action: 'start', workspaceId: 'work', views: 2, git: true })).toMatchObject({ views: 2 });
    const tree = { '雪.txt': 'modified', 'b.txt': 'untracked' };
    for (const listener of listeners) { listener({ paths: ['雪.txt'] }); listener({ git: { tree } }); }
    const result = await measureFilesWatchPage({ action: 'summary' });
    expect(result).toMatchObject({ views: 2, calls: [2, 2], paths: ['雪.txt'], treeCount: 2, treeSha256: createHash('sha256').update(JSON.stringify(tree)).digest('hex'), concurrentSettings: { ok: true } });
    expect(subscribe.mock.calls.map(([id, want]) => [id, want])).toEqual([['work', { git: true }], ['work', { git: true }]]);
    await measureFilesWatchPage({ action: 'stop' }); for (const off of offs) expect(off).toHaveBeenCalledTimes(1);
});
it('the watch VM helper refuses an absent app bridge', async () => {
    vi.stubGlobal('window', {}); const { measureFilesWatchPage } = await helper();
    await expect(measureFilesWatchPage({ action: 'start', workspaceId: 'work', views: 1 })).rejects.toThrow(/genieTest|page bridge/i);
});
