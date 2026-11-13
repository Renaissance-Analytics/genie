import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { inMemoryPair, type ClientTransport, type ServerConnection } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { hostRemoteApi, RemoteAccessHost } from '../src/main/remote-access-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { AgentWindows, connectRemote } from '../src/renderer/remote-bridge.js';

/*
 * A PHONE'S PHOTO SINCE THE HOST SPLIT (Tynn #657). The phone talks to genie-host; genie-host stages the bytes, and a
 * connected window answers the prompt through the engine link's reverse call (`client.remoteInvoke`). Driven end to end on
 * the real chain: the phone's bridge → genie-host's remote host (staging) → the engine link → the window's host API
 * `prompt` → `promptWith`. The bytes the agent gets must be the bytes the phone sent, as bytes, with their names.
 */

const TOKEN = 'attach-657-token';
const now = () => 1_000_000;

let home = '';
let token = '';
let server: SessionEngineServer;
let access: RemoteAccessHost;
const tailnet: Array<(c: ServerConnection) => void> = [];
const closers: Array<() => void> = [];
const sent: Array<{ agentId: string; text: string; attachments: ReadonlyArray<{ name: string; type: string; bytes: unknown }> }> = [];
const uploads: Array<{ workspaceId: string; dir: string; name: string; bytes: unknown }> = [];

const AGENT = { id: 'agent_a', name: 'atlas', workspaceId: 'ws_1' };

/** The window's own host API, as main.ts builds it, over a fake session host that records what reached `promptWith`. */
function windowHostApi() {
    const deps = {
        find: (id: string) => (id === AGENT.id ? AGENT : null),
        host: {
            promptWith: async (agentId: string, text: string, attachments: ReadonlyArray<{ name: string; type: string; bytes: unknown }>) => {
                sent.push({ agentId, text, attachments });
                return { ok: true };
            },
            prompt: async () => true,
        },
        files: {
            upload: async (workspaceId: string, dir: string, name: string, bytes: unknown) => {
                uploads.push({ workspaceId, dir, name, bytes });
                return { ok: true, path: `${dir}/${name}` };
            },
        },
    } as unknown as HostApiDeps;
    return buildHostApi(deps);
}

beforeEach(async () => {
    sent.length = 0;
    uploads.length = 0;
    tailnet.length = 0;
    home = await mkdtemp(join(tmpdir(), 'genie2-phone-attach-657-'));
    const before = await DeviceStore.open(home, { now, random: () => 'tok-phone' });
    token = before.pair('glenn’s phone').token;
    await before.flushed();
    access = await RemoteAccessHost.open({
        home, hostName: 'alphar', now,
        transport: { onConnection: (cb) => { tailnet.push(cb); return () => {}; } },
        api: hostRemoteApi({
            hostName: 'alphar',
            own: {},
            window: { connected: () => server.newestLocalWindow() !== null, invoke: (m, a, c) => server.remoteInvoke(m, a, c) },
        }),
    });
    server = new SessionEngineServer({ token: TOKEN, build: 't' });

    // This machine's window, linked to genie-host, answering what the host does not own with its own host API.
    const api = windowHostApi();
    const [h, raw] = memoryPair();
    server.accept(h, { local: true });
    const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage(l), onClose: (l) => raw.onClose(l), close: () => raw.close() };
    const client = new SessionEngineClient({ onRemoteInvoke: (method, args, context) => api.invoke(method as never, args, context) });
    expect(await client.connect(t, TOKEN)).toMatchObject({ ok: true });
    closers.push(() => t.close());
});

afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await access.close();
    await rm(home, { recursive: true, force: true });
});

/** The phone, on genie-host's tailnet transport, with its saved device token, driving. */
async function phone() {
    const pair = inMemoryPair();
    for (const cb of tailnet) cb(pair.server);
    const c = connectRemote(pair.client, { kind: 'token', token, label: 'phone' }, 'phone', { profile: 'mobile', windows: new AgentWindows() });
    closers.push(() => c.close());
    expect((await c.ready).ok).toBe(true);
    await c.takeBaton();
    return c;
}

const bytesOf = (n: number, seed: number, head: readonly number[]) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
    b.set(head, 0);
    return b;
};

describe('a phone\'s files in a message, through genie-host and the window (Tynn #657)', () => {
    it('a JPEG, a PNG and a text file reach promptWith as Uint8Array bytes equal to what the phone sent, with their names', async () => {
        const c = await phone();
        // Bigger than one upload chunk, so each crosses in several.
        const jpeg = bytesOf(700_000, 7, [0xff, 0xd8, 0xff, 0xe0]);
        const png = bytesOf(90_000, 3, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const text = new TextEncoder().encode('hello from the phone\n');
        const files = [
            { name: 'IMG_0412.jpg', type: 'image/jpeg', bytes: jpeg },
            { name: 'Screenshot.png', type: 'image/png', bytes: png },
            { name: 'notes.txt', type: 'text/plain', bytes: text },
        ];

        expect(await c.bridge.prompt(AGENT.id, 'see attached', files)).toEqual({ ok: true });

        expect(sent).toHaveLength(1);
        expect(sent[0]!.agentId).toBe(AGENT.id);
        expect(sent[0]!.text).toBe('see attached');
        expect(sent[0]!.attachments.map((a) => [a.name, a.type])).toEqual([['IMG_0412.jpg', 'image/jpeg'], ['Screenshot.png', 'image/png'], ['notes.txt', 'text/plain']]);
        sent[0]!.attachments.forEach((a, i) => {
            expect(a.bytes).toBeInstanceOf(Uint8Array);
            expect(Buffer.from(a.bytes as Uint8Array).equals(Buffer.from(files[i]!.bytes))).toBe(true);
        });
    });

    it('a phone\'s file upload reaches the window\'s files.upload as the same bytes', async () => {
        const c = await phone();
        const bytes = bytesOf(200_000, 11, [0xff, 0xd8, 0xff]);
        const r = await c.bridge.files.upload!('ws_1', 'docs', 'IMG_1.jpg', bytes);
        expect(r).toMatchObject({ ok: true });
        expect(uploads).toHaveLength(1);
        expect(uploads[0]!.name).toBe('IMG_1.jpg');
        expect(uploads[0]!.bytes).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(uploads[0]!.bytes as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
    });

    it('control: a text-only message from the phone reaches the window over the same link', async () => {
        const c = await phone();
        expect(await c.bridge.prompt(AGENT.id, 'just text')).toEqual({ ok: true });
        expect(sent).toEqual([{ agentId: AGENT.id, text: 'just text', attachments: [] }]);
    });
});
