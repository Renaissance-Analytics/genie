import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * A MESSAGE'S FILES HOLD UPLOAD SLOTS ONLY WHILE THAT MESSAGE IS BEING SENT (the owner, 2026-11-16).
 *
 * A message with files stages each file on the host (`upload.begin` / `upload.chunk`), then its one `prompt` call names
 * them and the host takes them. The host holds at most MAX_OPEN_UPLOADS (3) per connection. The owner pasted four images:
 * the fourth was refused at send ("only 3 uploads at a time"), and then — with the images deleted — the message still
 * would not send. The three files staged before the refusal were never aborted, so they held all three slots on the host
 * until its 10-minute sweep, and every send with a file in that time was refused.
 *
 * Every way a send can fail after staging must free what it staged: a later file refused, the host refusing the call
 * itself (no baton, a scope), an upload into the workspace refused. And two chats of one window sending at once must not
 * fight over the slots: the window sends its staged messages one after another.
 *
 * End to end against the real RemoteHost over the in-memory pair, as test/remote-bridge.test.ts does.
 */

const snapshot = { agents: [{ id: 'agent_a', name: 'atlas', workspaceId: 'tynn' }], workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }], deckItems: [], signals: {} };

function fakeApi() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const api: HostApi = {
        invoke: async (method, args) => {
            calls.push({ method, args });
            if (method === 'snapshot') return snapshot;
            if (method === 'agentDetail') return { agent: { id: args[0] }, rows: [] };
            return { ok: true };
        },
        onEvent: () => () => {},
        workspaceOfAgent: () => 'tynn',
    };
    return { api, calls };
}

let dir: string;
let api: ReturnType<typeof fakeApi>;
let devices: DeviceStore;
let accept: (c: ServerConnection) => void = () => {};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-upload-slots-'));
    api = fakeApi();
    devices = await DeviceStore.open(dir, { now: () => 1, random: () => 'tok' });
    const host = new RemoteHost({ confirm: allowEveryPairing,
        api: api.api,
        hostName: 'alphar',
        baton: new Baton(),
        pins: new PairingPins({ now: () => 1, random: () => 0.482913 }),
        devices,
        transport: { onConnection: (cb) => { accept = cb; return () => {}; } },
    });
    host.issuePin();
});

afterEach(async () => {
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

async function connect(options?: unknown) {
    const pair = inMemoryPair();
    accept(pair.server);
    const remote = (connectRemote as (...a: unknown[]) => ReturnType<typeof connectRemote>)(pair.client, { kind: 'pin', code: '482913' }, 'laptop', ...(options === undefined ? [] : [options]));
    expect(await remote.ready).toEqual({ ok: true });
    return remote;
}

const image = (n: number) => ({ name: `Pasted image ${n}.png`, type: 'image/png', bytes: new Uint8Array([n, 1, 2, 3]) });
const images = (...ns: number[]) => ns.map(image);
const prompted = () => api.calls.filter((c) => c.method === 'prompt');

describe('a message’s files hold upload slots only while it is being sent', () => {
    it('control: a message with three files sends, and the host receives all three', async () => {
        const remote = await connect();
        await remote.takeBaton();
        expect(await remote.bridge.prompt('agent_a', 'look', images(1, 2, 3))).toEqual({ ok: true });
        expect(prompted()).toHaveLength(1);
        expect((prompted()[0]!.args[2] as unknown[]).length).toBe(3);
    });

    it('a message refused for one file too many frees the files it had staged: the next message with one file sends', async () => {
        const remote = await connect();
        await remote.takeBaton();
        const refused = await remote.bridge.prompt('agent_a', 'four', images(1, 2, 3, 4));
        expect(refused).toMatchObject({ ok: false });
        expect(refused.reason).toContain('Pasted image 4.png');
        // The owner removed the extra image and pressed Send again.
        expect(await remote.bridge.prompt('agent_a', 'one', images(1))).toEqual({ ok: true });
        expect(prompted()).toHaveLength(1);
    });

    it('a message the host refuses (nobody holds the baton) frees its staged files: once driving, the same message sends', async () => {
        const remote = await connect();
        const first = await remote.bridge.prompt('agent_a', 'two', images(1, 2));
        expect(first).toMatchObject({ ok: false });
        await remote.takeBaton();
        expect(await remote.bridge.prompt('agent_a', 'two', images(1, 2))).toEqual({ ok: true });
        expect(prompted()).toHaveLength(1);
    });

    it('an upload into the workspace the host refuses frees its staged bytes', async () => {
        const remote = await connect({ profile: 'mobile' });
        for (let i = 0; i < 3; i++) {
            expect(await remote.bridge.files.upload!('tynn', 'docs', `a${i}.txt`, new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false });
        }
        await remote.takeBaton();
        expect(await remote.bridge.files.upload!('tynn', 'docs', 'b.txt', new Uint8Array([1, 2, 3]))).toEqual({ ok: true });
    });

    it('two chats sending at once both send: a window sends its staged messages one after another', async () => {
        const remote = await connect();
        await remote.takeBaton();
        const [a, b] = await Promise.all([
            remote.bridge.prompt('agent_a', 'from chat one', images(1, 2)),
            remote.bridge.prompt('agent_a', 'from chat two', images(3, 4)),
        ]);
        expect(a).toEqual({ ok: true });
        expect(b).toEqual({ ok: true });
        expect(prompted().map((c) => c.args[1])).toEqual(['from chat one', 'from chat two']);
    });
});
