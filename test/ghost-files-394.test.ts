import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FilesHost } from '../src/main/files-host.js';
import { FilesWatchHub, type FilesWatchHubOptions } from '../src/main/files-watch-hub.js';

it('story394: stale file requests cannot read a hibernated workspace, and work again after redock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-ghost-files-394-'));
    let asleep = false;
    const git = vi.fn(async () => ({}));
    const host = new FilesHost({ workspace: () => ({ id: 'ghost', path: dir, asleep }), agentsOf: () => [], eventsOf: () => [], gitTree: git });
    try {
        await writeFile(join(dir, 'kept.txt'), 'Local workspace contents');
        expect(await host.open('ghost', 'kept.txt')).toMatchObject({ ok: true, text: 'Local workspace contents' });
        asleep = true;
        expect(await host.tree('ghost')).toBeNull();
        expect(await host.children('ghost', '')).toBeNull();
        expect(await host.open('ghost', 'kept.txt')).toMatchObject({ ok: false });
        expect(await host.readBytes('ghost', 'kept.txt')).toMatchObject({ ok: false });
        expect(host.absolute('ghost', 'kept.txt')).toBeNull();
        expect(await host.gitStatus('ghost')).toEqual({}); expect(git).not.toHaveBeenCalled();
        asleep = false;
        expect(await host.open('ghost', 'kept.txt')).toMatchObject({ ok: true, text: 'Local workspace contents' });
    } finally { await host.close(); await rm(dir, { recursive: true, force: true }); }
});

it('story394: hibernation closes existing file watches, cancels pending reads, refuses new watches and restores live views on redock', async () => {
    let asleep = false;
    const close = vi.fn(), source = vi.fn((_path: string, _onPath: (path: string) => void) => ({ close }));
    const git = vi.fn(async () => ({})), cancel = vi.fn();
    const options = { send: vi.fn(), source, gitTree: git, schedule: () => cancel, workspaceVisible: () => !asleep } as FilesWatchHubOptions;
    const hub = new FilesWatchHub(options);
    const refresh = () => (hub as unknown as { visibilityChanged?: () => void }).visibilityChanged?.();
    try {
        hub.subscribe('window', 'files', { id: 'ghost', path: '/ghost' }, { git: true });
        expect(hub.watching()).toEqual(['ghost']);
        source.mock.calls[0]![1]('changed.txt');
        asleep = true; refresh();
        expect(hub.watching()).toEqual([]); expect(close).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
        hub.subscribe('window', 'second', { id: 'ghost', path: '/ghost' }, { git: true });
        expect(source).toHaveBeenCalledOnce(); expect(git).not.toHaveBeenCalled();
        asleep = false; refresh();
        expect(hub.watching()).toEqual(['ghost']); expect(source).toHaveBeenCalledTimes(2);
    } finally { hub.close(); }
});
