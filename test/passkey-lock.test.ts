import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PASSKEY_LOCK_METHODS, LOCKED_ALLOWED, PASSKEY_LOCK_EVENT, mayCallWhileLocked } from '../src/core/passkey-lock.js';
import { PasskeyLock, PasskeyLockError, windowLockClient } from '../src/main/passkey-lock.js';
import { SoftAuthenticator } from './support/soft-authenticator.js';

/**
 * THE PASSKEY LOCK'S JUDGE (Tynn #677, S1): genie-host decides, per connected client, whether it is locked, and runs the
 * WebAuthn ceremonies that enroll a device and unlock a client, through @particle-academy/fancy-passkeys over
 * @simplewebauthn/server — real signatures, from a software authenticator built to the spec (support/soft-authenticator).
 * Off by default; turning it on IS enrolling the device that asks. Credentials are public keys with their counters and a
 * device name; nothing secret is stored.
 */

const WINDOW = 'http://genie.localhost:24567';
let dir: string;
let file: string;
let lock: PasskeyLock;
let now = Date.parse('2026-11-13T12:00:00Z');

/** A local window client: rpId genie.localhost, its origin the window's current one. */
const windowClient = (origin = WINDOW, label = 'this desktop') => windowLockClient(() => origin, label);

async function enroll(clientId: string, auth: SoftAuthenticator, origin = WINDOW, name = 'Windows Hello') {
    const begun = await lock.call(clientId, 'passkeyLock.beginEnroll', [name]) as { state: string; publicKey: { challenge: string; rp: { id?: string }; user: { id: string } } };
    return lock.call(clientId, 'passkeyLock.finishEnroll', [begun.state, auth.create(begun.publicKey, { origin }), name]);
}
async function unlockWith(clientId: string, auth: SoftAuthenticator, page: { origin?: string; rpId?: string; counter?: number } = {}) {
    const begun = await lock.call(clientId, 'passkeyLock.beginUnlock', []) as { state: string; publicKey: { challenge: string; rpId?: string } };
    return lock.call(clientId, 'passkeyLock.finishUnlock', [begun.state, auth.get(begun.publicKey, { origin: page.origin ?? WINDOW, ...(page.rpId ? { rpId: page.rpId } : {}), ...(page.counter !== undefined ? { counter: page.counter } : {}) })]);
}
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as PasskeyLockError; } };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-passkey-lock-'));
    file = join(dir, 'runtime', 'passkey-lock.json');
    lock = await PasskeyLock.open({ file, now: () => now });
});
afterEach(async () => {
    await lock.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('the protocol table', () => {
    it('names its methods, and a locked client may call only status, lock, and the two halves of unlock', () => {
        expect([...PASSKEY_LOCK_METHODS].sort()).toEqual(['passkeyLock.beginEnroll', 'passkeyLock.beginUnlock', 'passkeyLock.devices', 'passkeyLock.disable', 'passkeyLock.finishEnroll', 'passkeyLock.finishUnlock', 'passkeyLock.lockNow', 'passkeyLock.removeDevice', 'passkeyLock.status']);
        expect([...LOCKED_ALLOWED].sort()).toEqual(['passkeyLock.beginUnlock', 'passkeyLock.finishUnlock', 'passkeyLock.lockNow', 'passkeyLock.status']);
        // Enrolling another device, turning the lock off and managing devices need an unlocked client.
        for (const m of ['passkeyLock.beginEnroll', 'passkeyLock.finishEnroll', 'passkeyLock.disable', 'passkeyLock.devices', 'passkeyLock.removeDevice', 'snapshot', 'openAgent', 'baton.take'])
            expect(mayCallWhileLocked(m), m).toBe(false);
        expect(PASSKEY_LOCK_EVENT).toBe('passkey-lock');
    });
});

describe('off by default', () => {
    it('a new install is not locked, no client is locked, and there is nothing to unlock', async () => {
        lock.attach('w1', windowClient());
        expect(lock.isLocked('w1')).toBe(false);
        expect(await lock.call('w1', 'passkeyLock.status', [])).toEqual({ enabled: false, locked: false, devices: 0, canUnlock: false });
        expect((await refusal(lock.call('w1', 'passkeyLock.beginUnlock', [])))?.code).toBe('not-enabled');
    });
});

describe('turning it on is enrolling this device', () => {
    it('the enrolling client stays unlocked, every other client is locked, and the store holds a public key, a counter and a name', async () => {
        lock.attach('w1', windowClient());
        lock.attach('w2', windowClient(WINDOW, 'second window process'));
        const changed: string[][] = [];
        lock.onChange((ids) => changed.push(ids));
        const auth = new SoftAuthenticator();
        expect(await enroll('w1', auth)).toMatchObject({ enabled: true, device: { id: auth.id, name: 'Windows Hello' } });
        expect(lock.isLocked('w1')).toBe(false);
        expect(lock.isLocked('w2')).toBe(true);
        expect(changed.flat()).toContain('w2');
        await lock.flushed();
        const stored = JSON.parse(await readFile(file, 'utf8')) as { version: number; enabled: boolean; userHandle: string; credentials: Array<Record<string, unknown>> };
        expect(stored.enabled).toBe(true);
        expect(stored.credentials).toHaveLength(1);
        const c = stored.credentials[0]!;
        expect(c).toMatchObject({ id: auth.id, rpId: 'genie.localhost', signCount: 0, name: 'Windows Hello' });
        expect(typeof c.publicKey).toBe('string');
        // Nothing but public material: no private key, no token, no secret of any name.
        expect(Object.keys(c).filter((k) => /private|secret|token|password/i.test(k))).toEqual([]);
        expect(JSON.stringify(stored)).not.toMatch(/PRIVATE KEY|"d":/);
    });

    it('a client that is locked cannot enroll another device, turn the lock off, or list and remove devices', async () => {
        lock.attach('w1', windowClient());
        await enroll('w1', new SoftAuthenticator());
        lock.attach('phone', windowClient(WINDOW, 'phone'));
        expect(lock.isLocked('phone')).toBe(true);
        for (const [method, args] of [['passkeyLock.beginEnroll', ['x']], ['passkeyLock.finishEnroll', ['s', {}, 'x']], ['passkeyLock.disable', []], ['passkeyLock.devices', []], ['passkeyLock.removeDevice', ['id']]] as const)
            expect((await refusal(lock.call('phone', method, [...args])))?.code, method).toBe('locked');
        // Positive control: the unlocked client can.
        expect(await lock.call('w1', 'passkeyLock.devices', [])).toHaveLength(1);
    });
});

describe('unlocking', () => {
    let auth: SoftAuthenticator;
    beforeEach(async () => {
        lock.attach('w1', windowClient());
        auth = new SoftAuthenticator();
        await enroll('w1', auth);
        lock.attach('w2', windowClient());
        expect(lock.isLocked('w2')).toBe(true);
    });

    it('a valid assertion from the window origin unlocks that client, and only that client; its counter is kept', async () => {
        lock.attach('w3', windowClient());
        expect(await unlockWith('w2', auth)).toEqual({ locked: false });
        expect(lock.isLocked('w2')).toBe(false);
        expect(lock.isLocked('w3')).toBe(true);
        await lock.flushed();
        expect((JSON.parse(await readFile(file, 'utf8')) as { credentials: Array<{ signCount: number }> }).credentials[0]!.signCount).toBe(1);
    });

    it('an assertion made on another origin is refused and the client stays locked', async () => {
        expect((await refusal(unlockWith('w2', auth, { origin: 'http://genie.localhost:1' })))?.code).toBe('passkey');
        expect((await refusal(unlockWith('w2', auth, { origin: 'https://evil.example' })))?.code).toBe('passkey');
        expect(lock.isLocked('w2')).toBe(true);
    });

    it('an assertion for another rpId is refused', async () => {
        expect((await refusal(unlockWith('w2', auth, { rpId: 'localhost' })))?.code).toBe('passkey');
        expect(lock.isLocked('w2')).toBe(true);
    });

    it('a challenge is single-use, and belongs to the client that asked for it', async () => {
        const begun = await lock.call('w2', 'passkeyLock.beginUnlock', []) as { state: string; publicKey: { challenge: string; rpId?: string } };
        const answer = auth.get(begun.publicKey, { origin: WINDOW });
        // Another client presenting w2's ceremony: refused, and w2 is not unlocked by it.
        lock.attach('w3', windowClient());
        expect((await refusal(lock.call('w3', 'passkeyLock.finishUnlock', [begun.state, answer])))?.code).toBe('passkey');
        expect(lock.isLocked('w3')).toBe(true);
        expect(await lock.call('w2', 'passkeyLock.finishUnlock', [begun.state, answer])).toEqual({ locked: false });
        // Replayed: the challenge was used.
        await lock.call('w2', 'passkeyLock.lockNow', []);
        expect((await refusal(lock.call('w2', 'passkeyLock.finishUnlock', [begun.state, answer])))?.code).toBe('passkey');
        expect(lock.isLocked('w2')).toBe(true);
        // An assertion signed for a challenge this host never issued.
        const forged = auth.get({ challenge: Buffer.from('not ours').toString('base64url'), rpId: 'genie.localhost' }, { origin: WINDOW });
        const fresh = await lock.call('w2', 'passkeyLock.beginUnlock', []) as { state: string };
        expect((await refusal(lock.call('w2', 'passkeyLock.finishUnlock', [fresh.state, forged])))?.code).toBe('passkey');
        expect(lock.isLocked('w2')).toBe(true);
    });

    it('a signature counter that goes backwards is refused, and the credential is marked', async () => {
        await unlockWith('w2', auth, { counter: 5 });
        await lock.call('w2', 'passkeyLock.lockNow', []);
        expect((await refusal(unlockWith('w2', auth, { counter: 3 })))?.code).toBe('passkey');
        expect(lock.isLocked('w2')).toBe(true);
        await lock.flushed();
        expect((JSON.parse(await readFile(file, 'utf8')) as { credentials: Array<{ clonedAt: string | null }> }).credentials[0]!.clonedAt).not.toBeNull();
    });

    it('a client whose window origin is not known cannot run a ceremony', async () => {
        lock.attach('nowhere', windowLockClient(() => null, 'no origin'));
        expect((await refusal(lock.call('nowhere', 'passkeyLock.beginUnlock', [])))?.code).toBe('no-origin');
        expect(lock.isLocked('nowhere')).toBe(true);
    });

    it('lock now locks; a client that is gone is forgotten; an unknown client is locked', async () => {
        await unlockWith('w2', auth);
        await lock.call('w2', 'passkeyLock.lockNow', []);
        expect(lock.isLocked('w2')).toBe(true);
        lock.detach('w2');
        expect(lock.isLocked('w2')).toBe(true);
        expect(lock.isLocked('never-attached')).toBe(true);
    });
});

describe('devices and turning it off', () => {
    it('the last device cannot be removed while the lock is on; turning it off unlocks everyone', async () => {
        lock.attach('w1', windowClient());
        const auth = new SoftAuthenticator();
        await enroll('w1', auth);
        lock.attach('w2', windowClient());
        expect((await refusal(lock.call('w1', 'passkeyLock.removeDevice', [auth.id])))?.code).toBe('last-device');
        expect(await lock.call('w1', 'passkeyLock.disable', [])).toEqual({ enabled: false });
        expect(lock.isLocked('w2')).toBe(false);
        expect(await lock.call('w1', 'passkeyLock.removeDevice', [auth.id])).toBe(true);
    });

    it('what was enrolled survives a restart, and every client is locked again', async () => {
        lock.attach('w1', windowClient());
        const auth = new SoftAuthenticator();
        await enroll('w1', auth);
        await lock.flushed();
        const again = await PasskeyLock.open({ file, now: () => now });
        again.attach('w1', windowClient());
        expect(again.isLocked('w1')).toBe(true);
        lock = again;
        expect(await unlockWith('w1', auth)).toEqual({ locked: false });
    });
});

describe('a lock file Genie cannot read', () => {
    it.each([
        ['not JSON', 'nonsense'],
        ['a credential that is not one', JSON.stringify({ version: 1, enabled: true, userHandle: 'h', credentials: [{ id: 'x' }] })],
        ['on, with no credential', JSON.stringify({ version: 1, enabled: true, userHandle: 'h', credentials: [] })],
        ['another version', JSON.stringify({ version: 2, enabled: false, userHandle: 'h', credentials: [] })],
    ])('%s: is never read as off — every client is locked, nothing unlocks, and the file is left as it is', async (_name, text) => {
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(join(dir, 'runtime'), { recursive: true });
        await writeFile(file, text);
        const damaged = await PasskeyLock.open({ file, now: () => now });
        damaged.attach('w1', windowClient());
        expect(damaged.isLocked('w1')).toBe(true);
        expect(damaged.status('w1')).toMatchObject({ enabled: true, locked: true, damaged: true, canUnlock: false });
        for (const [method, args] of [['passkeyLock.beginUnlock', []], ['passkeyLock.disable', []], ['passkeyLock.beginEnroll', ['x']]] as const)
            expect(await refusal(damaged.call('w1', method, [...args])), method).not.toBeNull();
        expect(damaged.isLocked('w1')).toBe(true);
        await damaged.flushed();
        expect(await readFile(file, 'utf8')).toBe(text);
        // Control: a file Genie wrote is read as written.
        expect((await PasskeyLock.open({ file: join(dir, 'absent.json') })).status('x')).toEqual({ enabled: false, locked: false, devices: 0, canUnlock: false });
    });
});
