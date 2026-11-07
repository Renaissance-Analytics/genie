import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileEvent } from '../src/core/files-panel.js';
import type { LocalFilesMethod } from '../src/core/local-files.js';
import { FilesHost, type FilesState } from '../src/main/files-host.js';
import { invokeLocalFiles } from '../src/main/local-files-api.js';
import { localFilesClient } from '../src/renderer/local-files-client.js';

/*
 * FILES STATE BY CURSOR (Tynn #522, UI lag L2). `files.state` answered every call with every path changed this session,
 * and a view calls it once per batch of disk changes: measured in the real window during a build (genie#1677's row),
 * about 66 page transfers per call and the top cost on window main, growing with the session. Now a caller passes the
 * cursor of its last read and is sent only what changed since; the window's client keeps the rest and answers each view
 * with the whole state, exactly what a full read would say.
 */

let root: string;
let host: FilesHost;
const events = new Map<string, FileEvent[]>();
const agents = [{ id: 'agent_kora', name: 'kora' }];
const edit = (path: string): FileEvent => ({ agentId: 'agent_kora', agentName: 'kora', toolKind: 'edit', status: 'completed', rawInput: { file_path: join(root, path) } });

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-files-cursor-'));
    events.clear();
    host = new FilesHost({ workspace: (id) => (id === 'tynn' ? { id: 'tynn', path: root } : null), agentsOf: () => agents, eventsOf: (id) => events.get(id) ?? [] });
});
afterEach(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
});

type Since = { cursor: string; since: string | null; disk: Array<{ path: string; at: number }>; gone: string[]; changed: FilesState['changed'] };
const stateSince = (cursor: string | null) => (host.state as unknown as (id: string, cursor: string | null) => Promise<Since | null>)('tynn', cursor);

describe('FilesHost.state with a cursor', () => {
    it('a first read (no cursor) is the whole set; a read with its cursor is only what changed since', async () => {
        host.recordDiskChanges('tynn', [{ path: 'a.ts', at: 1 }, { path: 'b.ts', at: 2 }, { path: 'c.ts', at: 3 }]);
        const first = await stateSince(null);
        expect(first).toMatchObject({ since: null, disk: [{ path: 'a.ts', at: 1 }, { path: 'b.ts', at: 2 }, { path: 'c.ts', at: 3 }], gone: [] });
        expect(typeof first!.cursor).toBe('string');

        host.recordDiskChanges('tynn', [{ path: 'b.ts', at: 4 }, { path: 'd.ts', at: 5 }]);
        const next = await stateSince(first!.cursor);
        expect(next).toMatchObject({ since: first!.cursor, disk: [{ path: 'b.ts', at: 4 }, { path: 'd.ts', at: 5 }], gone: [] });
        expect(next!.cursor).not.toBe(first!.cursor);

        // Nothing since: nothing sent.
        expect(await stateSince(next!.cursor)).toMatchObject({ since: next!.cursor, disk: [], gone: [] });
    });

    it('the cost of a read with a cursor does not grow with the session: 30,000 earlier paths, 3 sent', async () => {
        host.recordDiskChanges('tynn', Array.from({ length: 30_000 }, (_, i) => ({ path: `gen/f${i}.js`, at: i })));
        const first = await stateSince(null);
        expect(first!.disk).toHaveLength(30_000);
        host.recordDiskChanges('tynn', [{ path: 'x.ts', at: 40_000 }, { path: 'y.ts', at: 40_001 }, { path: 'gen/f7.js', at: 40_002 }]);
        const next = await stateSince(first!.cursor);
        // In the order Genie first saw them: a path seen before keeps its place.
        expect(next!.disk.map((d) => d.path)).toEqual(['gen/f7.js', 'x.ts', 'y.ts']);
        // The unreported list and its `?` group are the window's to rebuild: never resent whole.
        expect(JSON.stringify(next).length).toBeLessThan(2_000);
    });

    it('a path the person wrote leaves the disk set, and a read with a cursor says it is gone', async () => {
        host.recordDiskChanges('tynn', [{ path: 'notes.md', at: 1 }]);
        const first = await stateSince(null);
        await host.write('tynn', 'notes.md', 'mine\n', null);
        const next = await stateSince(first!.cursor);
        expect(next).toMatchObject({ disk: [], gone: ['notes.md'] });
    });

    it('a cursor this host did not give (another session, or garbage) is answered with the whole set', async () => {
        host.recordDiskChanges('tynn', [{ path: 'a.ts', at: 1 }]);
        for (const stale of ['other-epoch.1', 'garbage', '']) expect(await stateSince(stale)).toMatchObject({ since: null, disk: [{ path: 'a.ts', at: 1 }] });
    });

    it('CONTROL: a read with no cursor argument at all is the full state, as before (a client that sends none)', async () => {
        host.recordDiskChanges('tynn', [{ path: 'a.ts', at: 1 }]);
        expect(await host.state('tynn')).toEqual({ files: [], activity: [], unreported: ['a.ts'], changed: [{ who: '?', files: ['a.ts'] }], diskChanges: [{ path: 'a.ts', at: 1 }] });
    });
});

describe('the window\'s client keeps the state and asks only for what changed', () => {
    const client = (calls: unknown[][]) => localFilesClient({
        read: async <T,>(method: LocalFilesMethod, ...args: unknown[]) => {
            calls.push([method, ...args]);
            return await invokeLocalFiles({ files: () => host, editor: () => null, repo: async () => null }, method, args) as T;
        },
        release: async () => ({}),
    } as unknown as Parameters<typeof localFilesClient>[0]).files;

    it('sends its last cursor, and each answer equals a full read: changes, repeats, attribution, your writes', async () => {
        const calls: unknown[][] = [];
        const files = client(calls);
        const same = async () => expect(await files.state('tynn')).toEqual(await host.state('tynn'));

        host.recordDiskChanges('tynn', [{ path: 'a.ts', at: 1 }, { path: 'b.ts', at: 2 }]);
        await same();
        host.recordDiskChanges('tynn', [{ path: 'c.ts', at: 3 }, { path: 'a.ts', at: 4 }]);
        await same();
        events.set('agent_kora', [edit('b.ts')]); // b.ts is now kora's, not `?`
        await same();
        await host.write('tynn', 'c.ts', 'yours\n', null); // c.ts was on the disk list: yours now, so gone from it
        await same();
        await host.write('tynn', 'yours.md', 'yours\n', null);
        await same();
        host.recordDiskChanges('tynn', [{ path: 'yours.md', at: 6 }, { path: 'd.ts', at: 7 }]);
        await same();

        const stateCalls = calls.filter((c) => c[0] === 'files.state');
        expect(stateCalls[0]).toEqual(['files.state', 'tynn', null]);
        // Every later read names a cursor: none asks for the whole set again.
        for (const c of stateCalls.slice(1)) expect(typeof c[2]).toBe('string');
    });

    it('an answer older than one already applied changes nothing (two reads in flight)', async () => {
        const calls: unknown[][] = [];
        const files = client(calls);
        host.recordDiskChanges('tynn', [{ path: 'a.ts', at: 1 }]);
        await files.state('tynn');
        host.recordDiskChanges('tynn', [{ path: 'b.ts', at: 2 }]);
        const [x, y] = await Promise.all([files.state('tynn'), files.state('tynn')]);
        expect(x).toEqual(await host.state('tynn'));
        expect(y).toEqual(await host.state('tynn'));
    });
});
