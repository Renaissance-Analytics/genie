import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { FilesHubEvent } from '../src/main/files-watch-hub.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';

/**
 * THE FILE WATCHER'S SUBSCRIPTIONS RIDE THE ENGINE LINK (the host split, P2.2: plan §11b). The hub runs in genie-host; a
 * window subscribes its views (`files.watch`), unsubscribes them (`files.unwatch`), and hears the batches and git of the
 * workspaces ITS views watch — no other window's. A window whose link closes drops every view it had (a crashed window
 * watches nothing), and a window that reconnects subscribes its views again (the host lost them with the link).
 */

const TOKEN = 'files-token';
const tick = () => new Promise((r) => setTimeout(r, 0));
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const WS = { id: 'tynn', path: '/w/tynn' };

async function rig() {
    const calls: string[] = [];
    let server!: SessionEngineServer;
    const files = {
        subscribe: (owner: string, viewId: string, ws: { id: string; path: string }, want: unknown) => { calls.push(`sub ${owner === '' ? '?' : 'conn'} ${viewId} ${ws.id} ${JSON.stringify(want)}`); owners.set(viewId, owner); },
        unsubscribe: (owner: string, viewId: string) => { calls.push(`unsub ${viewId}`); void owner; },
        dropOwner: (owner: string) => { calls.push(`drop ${[...owners].filter(([, o]) => o === owner).map(([v]) => v).join(',')}`); },
    };
    const owners = new Map<string, string>();
    server = new SessionEngineServer({ token: TOKEN, build: 't', files });
    const host = new SessionHost({ userData: await mkdtemp(join(tmpdir(), 'files-tunnel-')), driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() });
    server.attach(host);
    const connect = async () => {
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
        return { client, windowSide };
    };
    return { server, calls, owners, connect };
}

describe('files subscriptions over the engine link', () => {
    it('a view subscribes and unsubscribes through the link, under ITS connection', async () => {
        const r = await rig();
        const w = await r.connect();
        expect(await w.client.filesWatch('panel-1', WS, { git: true })).toBe(true);
        expect(await w.client.filesUnwatch('panel-1')).toBe(true);
        expect(r.calls).toEqual(['sub conn panel-1 tynn {"git":true}', 'unsub panel-1']);
    });

    it('a batch goes to the connection whose view watches, and to no other window', async () => {
        const r = await rig();
        const a = await r.connect();
        const b = await r.connect();
        const heardA: FilesHubEvent[] = [];
        const heardB: FilesHubEvent[] = [];
        a.client.onFilesEvent((e) => heardA.push(e));
        b.client.onFilesEvent((e) => heardB.push(e));
        await a.client.filesWatch('panel-1', WS, {});
        const event: FilesHubEvent = { kind: 'changed', workspaceId: 'tynn', changes: [{ path: 'a.ts', at: 1 }] };
        r.server.filesEvent(r.owners.get('panel-1')!, event);
        await tick(); await tick();
        expect(heardA).toEqual([event]);
        expect(heardB).toEqual([]);
    });

    it('a window whose link closes drops every view it had', async () => {
        const r = await rig();
        const w = await r.connect();
        await w.client.filesWatch('panel-1', WS, {});
        await w.client.filesWatch('repo-1', WS, { repos: ['repos/genie'] });
        w.windowSide.close();
        await tick(); await tick();
        expect(r.calls.at(-1)).toBe('drop panel-1,repo-1');
    });

    it('a window that connects again subscribes its views again (the host dropped them with the old link); an unwatched one is not', async () => {
        const r = await rig();
        const client = new SessionEngineClient();
        const [h1, w1] = memoryPair();
        r.server.accept(h1);
        await client.connect(w1, TOKEN);
        await client.filesWatch('panel-1', WS, { git: true });
        await client.filesWatch('gone-1', WS, {});
        await client.filesUnwatch('gone-1');
        w1.close();
        await tick(); await tick();
        r.calls.length = 0;
        const [h2, w2] = memoryPair();
        r.server.accept(h2);
        await client.connect(w2, TOKEN);
        await tick(); await tick();
        expect(r.calls).toEqual(['sub conn panel-1 tynn {"git":true}']);
    });
});
