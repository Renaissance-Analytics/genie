import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { PasskeyLock } from '../src/main/passkey-lock.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SoftAuthenticator } from './support/soft-authenticator.js';

/**
 * A GENIE WINDOW IS A CLIENT OF THE LOCK (Tynn #677, S1): the window process reaches genie-host's lock over its engine
 * link (`engine.passkeyLock`), from a LOCAL window only. It says which origin its pages load from (Tynn #683) — the one
 * thing the host cannot know — and the host checks every ceremony of that window against it. Each window connection is its
 * own client: unlocking one leaves another locked, and its lock's changes come to it as `passkeyLock.event`.
 */

const ORIGIN = 'http://genie.localhost:24567';
let dir: string;
let lock: PasskeyLock;

async function link(local: boolean) {
    const server = new SessionEngineServer({ token: 't', build: 'b', passkeyLock: lock });
    const [h, raw] = memoryPair();
    server.accept(h, { local });
    const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage(l), onClose: (l) => raw.onClose(l), close: () => raw.close() };
    const client = new SessionEngineClient({});
    expect(await client.connect(t, 't')).toMatchObject({ ok: true });
    return client;
}
const call = async (client: SessionEngineClient, method: string, ...args: unknown[]) => client.call('engine.passkeyLock', [method, args]);

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-lock-engine-'));
    lock = await PasskeyLock.open({ file: join(dir, 'passkey-lock.json') });
});
afterEach(async () => {
    await lock.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('engine.passkeyLock', () => {
    it('is on the engine allowlist, and is a local window’s only (control: a local window reads its status)', async () => {
        expect(ENGINE_METHODS as readonly string[]).toContain('engine.passkeyLock');
        const remote = await link(false);
        await expect(call(remote, 'passkeyLock.status')).resolves.toEqual({ ok: false, reason: 'The passkey lock is reached from a local window only.' });
        const local = await link(true);
        await expect(call(local, 'passkeyLock.status')).resolves.toEqual({ ok: true, value: { enabled: false, locked: false, devices: 0, canUnlock: false } });
    });

    it('only a Genie window origin is taken as the window’s', async () => {
        const w = await link(true);
        for (const bad of ['https://evil.example', 'http://localhost:1', 'http://127.0.0.1:2', 'http://genie.localhost', 42])
            await expect(call(w, 'window', bad), String(bad)).resolves.toMatchObject({ ok: false });
        await expect(call(w, 'window', ORIGIN)).resolves.toEqual({ ok: true, value: true });
    });

    it('a window enrolls (turning the lock on), another window is locked and told, and unlocks with the same passkey', async () => {
        const auth = new SoftAuthenticator();
        const a = await link(true);
        const b = await link(true);
        await call(a, 'window', ORIGIN);
        await call(b, 'window', ORIGIN);
        const events: unknown[] = [];
        b.onPasskeyLock((status) => events.push(status));
        const begun = (await call(a, 'passkeyLock.beginEnroll', 'Windows Hello')) as { ok: true; value: { state: string; publicKey: { challenge: string; rp: { id?: string }; user: { id: string } } } };
        expect(await call(a, 'passkeyLock.finishEnroll', begun.value.state, auth.create(begun.value.publicKey, { origin: ORIGIN }), 'Windows Hello')).toMatchObject({ ok: true, value: { enabled: true } });
        await new Promise((r) => setTimeout(r, 20));
        expect(events).toContainEqual(expect.objectContaining({ enabled: true, locked: true }));
        expect(await call(b, 'passkeyLock.status')).toMatchObject({ ok: true, value: { locked: true } });
        expect(await call(a, 'passkeyLock.status')).toMatchObject({ ok: true, value: { locked: false } });
        // Locked, b may not manage the lock.
        expect(await call(b, 'passkeyLock.disable')).toMatchObject({ ok: false });
        const u = (await call(b, 'passkeyLock.beginUnlock')) as { ok: true; value: { state: string; publicKey: { challenge: string; rpId?: string } } };
        expect(await call(b, 'passkeyLock.finishUnlock', u.value.state, auth.get(u.value.publicKey, { origin: ORIGIN }))).toEqual({ ok: true, value: { locked: false } });
        expect(lock.enabled).toBe(true);
    });

    it('a window that left is forgotten', async () => {
        const auth = new SoftAuthenticator();
        const a = await link(true);
        await call(a, 'window', ORIGIN);
        const begun = (await call(a, 'passkeyLock.beginEnroll', 'x')) as { ok: true; value: { state: string; publicKey: { challenge: string; rp: { id?: string }; user: { id: string } } } };
        await call(a, 'passkeyLock.finishEnroll', begun.value.state, auth.create(begun.value.publicKey, { origin: ORIGIN }), 'x');
        const c = await link(true);
        await call(c, 'window', ORIGIN);
        expect(await call(c, 'passkeyLock.status')).toMatchObject({ ok: true, value: { locked: true } });
    });
});
