import { describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { SpawnFrame } from '../src/main/spawn-host-protocol.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE SPAWN HOST'S FRAMES RIDE THE ENGINE LINK (the host split, P2.1: plan §11a). genie-host's two spawn-host children
 * (processes, terminals) are reached by the window through the link it already has: \`engine.spawn [profile, frame]\` out,
 * \`spawn.frame {profile, frame}\` back. Out-frames are NOTIFICATIONS (no result per keystroke); the window hears the link
 * come up and go down, which is when its spawn clients reconcile and when they stop sending.
 */

const TOKEN = 'b'.repeat(64);
const tick = () => new Promise((r) => setTimeout(r, 0));

// Never the real process tree in a test (test/no-live-process-tree.test.ts).
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

async function pair() {
    const toChildren: Array<{ profile: string; frame: SpawnFrame }> = [];
    let windowsGone = 0;
    const server = new SessionEngineServer({ token: TOKEN, build: 't', spawn: { send: (profile, frame) => toChildren.push({ profile, frame }), windowGone: () => { windowsGone += 1; } } });
    const host = new SessionHost({ userData: await mkdtemp(join(tmpdir(), 'tunnel-')), driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() });
    server.attach(host);
    const [hostSide, windowSide] = memoryPair();
    const sent: string[] = [];
    const send = hostSide.send.bind(hostSide);
    hostSide.send = (t: string) => { sent.push(t); send(t); };
    server.accept(hostSide);
    const ups: number[] = [];
    const downs: string[] = [];
    const client = new SessionEngineClient();
    client.onLink(() => ups.push(1), (why) => downs.push(why));
    expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
    return { server, client, toChildren, sent, ups, downs, windowSide, gone: () => windowsGone };
}

describe('spawn frames over the engine link', () => {
    it('a frame the window sends reaches the host\'s relay for its profile, and NO result comes back for it', async () => {
        const p = await pair();
        const frame: SpawnFrame = { kind: 'call', id: 0, method: 'pty.write', args: ['term_1', 'ls\r'] };
        const link = p.client.spawnLink('terminals');
        const before = p.sent.length;
        link.send(frame);
        await tick(); await tick();
        expect(p.toChildren).toEqual([{ profile: 'terminals', frame }]);
        expect(p.sent.slice(before).filter((t) => t.includes('"kind":"result"'))).toEqual([]);
    });

    it('a frame from a child reaches the window\'s listener for that profile only', async () => {
        const p = await pair();
        const got: Array<[string, SpawnFrame]> = [];
        p.client.onSpawnFrame('processes', (f) => got.push(['processes', f]));
        p.client.onSpawnFrame('terminals', (f) => got.push(['terminals', f]));
        const frame: SpawnFrame = { kind: 'event', channel: 'pty.data', payload: { id: 'term_9', data: 'hi' } };
        p.server.spawnFrame('processes', frame);
        await tick(); await tick();
        expect(got).toEqual([['processes', frame]]);
    });

    it('the window hears the link up once connected, and down when it closes; the host hears the window go', async () => {
        const p = await pair();
        expect(p.ups).toEqual([1]);
        p.windowSide.close();
        await tick(); await tick();
        expect(p.downs).toHaveLength(1);
        expect(p.gone()).toBe(1);
    });
});
