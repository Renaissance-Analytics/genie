import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
    InMemoryChallengeStore,
    PasskeyError,
    PasskeyServer,
    RelyingParty,
    toPasskeySummary,
    type CredentialStore,
    type PasskeySummary,
    type StoredCredential,
} from '@particle-academy/fancy-passkeys';
import { LOCKED_ALLOWED, WINDOW_RP_ID, isPasskeyLockMethod, type PasskeyLockStatus } from '../core/passkey-lock.js';

/**
 * THE PASSKEY LOCK'S JUDGE (Tynn #677, S1), in genie-host. Off by default. Turning it on IS enrolling the device that
 * asks: that client stays unlocked and every other connected client is locked. While it is on, every client starts locked
 * and is unlocked only by a passkey ceremony it ran itself; lock now locks it again. Agents, sites and processes are
 * untouched: the lock decides what a CLIENT may ask, not what the host runs.
 *
 * Ceremonies run through @particle-academy/fancy-passkeys (challenge issue, single use and expiry; credential-id
 * uniqueness; the signature counter), which verifies with @simplewebauthn/server. Each client has its own relying party —
 * a Genie window is `genie.localhost` (Tynn #683), a phone on the tailnet its MagicDNS name — and its OWN expected origin,
 * resolved at every verification from what the host knows of that client (the window's current port, the listener's
 * address), never from the response being checked. Each client also has its own challenge store, so a ceremony begun by
 * one client cannot be finished by another.
 *
 * Stored at `<genie>/runtime/passkey-lock.json`: whether the lock is on, the one owner's user handle, and per credential
 * its public key, counter, relying party and device name. Public material only; nothing in it unlocks anything.
 */

export type PasskeyLockErrorCode = 'locked' | 'not-enabled' | 'no-origin' | 'passkey' | 'last-device' | 'bad-request';

export class PasskeyLockError extends Error {
    readonly code: PasskeyLockErrorCode;
    constructor(code: PasskeyLockErrorCode, message: string) {
        super(message);
        this.name = 'PasskeyLockError';
        this.code = code;
    }
}

/** Who a client is to the lock: the relying party its page belongs to, and its origin now (null: not known, no ceremony). */
export interface LockClient {
    readonly rpId: string | null;
    readonly origin: () => string | null;
    readonly label: string;
}

/** One of Genie's own windows: rpId genie.localhost, its origin the window's current http://genie.localhost:<port>. */
export function windowLockClient(origin: () => string | null, label: string): LockClient {
    return { rpId: WINDOW_RP_ID, origin: () => { const o = origin(); return o !== null && /^http:\/\/genie\.localhost:\d{1,5}$/.test(o) ? o : null; }, label };
}

/**
 * A phone on the tailnet, on the page genie-host serves (remote-listen.ts): its rpId is the host's MagicDNS name and its
 * origin `https://<name>:<port>`. Only an HTTPS page can run a ceremony; the plain-http fallback has no origin here, so a
 * phone there stays locked while the lock is on.
 */
export function tailnetLockClient(socketUrl: () => string | null, label: string): LockClient {
    const page = (): URL | null => {
        const url = socketUrl();
        if (url === null) return null;
        try { const u = new URL(url); return u.protocol === 'wss:' ? u : null; } catch { return null; }
    };
    return {
        rpId: page()?.hostname ?? null,
        origin: () => { const u = page(); return u ? `https://${u.host}` : null; },
        label,
    };
}

/** A client the lock cannot verify (a Pilot over the relay, until S3): it stays locked while the lock is on. */
export function unverifiableLockClient(label: string): LockClient {
    return { rpId: null, origin: () => null, label };
}

type Credential = StoredCredential & { readonly rpId: string };
interface LockFile {
    version: 1;
    enabled: boolean;
    userHandle: string;
    credentials: Credential[];
}

/** What RemoteHost asks of the lock (the gate): `PasskeyLock` is one. */
export interface PasskeyLockGate {
    attach(clientId: string, client: LockClient): void;
    detach(clientId: string): void;
    isLocked(clientId: string): boolean;
    status(clientId: string): PasskeyLockStatus;
    call(clientId: string, method: string, args: unknown[]): Promise<unknown>;
    onChange(listener: (clientIds: readonly string[]) => void): () => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isCredential = (c: unknown): c is Credential => isRecord(c) && typeof c.id === 'string' && typeof c.publicKey === 'string' && typeof c.rpId === 'string'
    && typeof c.userHandle === 'string' && typeof c.signCount === 'number' && Array.isArray(c.transports);

/**
 * The file, or null when it is not one Genie wrote. Nothing in it is dropped or repaired: a file with one bad credential,
 * or "on" with no credential, is not a lock file — reading it as anything else could turn the lock off.
 */
function parseFile(text: string): LockFile | null {
    try {
        const v: unknown = JSON.parse(text);
        if (!isRecord(v) || v.version !== 1 || typeof v.enabled !== 'boolean' || typeof v.userHandle !== 'string' || !Array.isArray(v.credentials)) return null;
        if (!v.credentials.every(isCredential)) return null;
        if (v.enabled && v.credentials.length === 0) return null;
        return { version: 1, enabled: v.enabled, userHandle: v.userHandle, credentials: v.credentials };
    } catch {
        return null;
    }
}

interface ClientState {
    readonly client: LockClient;
    unlocked: boolean;
    readonly server: PasskeyServer | null;
}

export class PasskeyLock implements PasskeyLockGate {
    readonly #file: string;
    readonly #now: () => number;
    #data: LockFile;
    #writing: Promise<void> = Promise.resolve();
    /** The file could not be read as a lock: every client is locked, nothing unlocks, and the file is never written over. */
    readonly #damaged: boolean;
    readonly #clients = new Map<string, ClientState>();
    readonly #listeners = new Set<(ids: readonly string[]) => void>();

    private constructor(file: string, data: LockFile, now: () => number, damaged: boolean) {
        this.#file = file;
        this.#data = data;
        this.#now = now;
        this.#damaged = damaged;
    }

    /**
     * Read the lock from `file`. A file that is missing is the default (off). One that cannot be read as a lock is never
     * read as "off" — that would turn the lock off by damaging a file: the lock is then ON with nothing that unlocks it
     * (agents, sites and processes run on), `damaged` says so, and the file is left exactly as it is.
     */
    static async open(options: { file: string; now?: () => number }): Promise<PasskeyLock> {
        const now = options.now ?? Date.now;
        const text = await readFile(options.file, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : ''));
        if (text === null) return new PasskeyLock(options.file, { version: 1, enabled: false, userHandle: randomBytes(32).toString('base64url'), credentials: [] }, now, false);
        const parsed = parseFile(text);
        if (parsed === null) return new PasskeyLock(options.file, { version: 1, enabled: true, userHandle: '', credentials: [] }, now, true);
        return new PasskeyLock(options.file, parsed, now, false);
    }

    /** The lock file could not be read: everything is locked and nothing unlocks until it is put right. */
    get damaged(): boolean { return this.#damaged; }

    /** Settles once every change made so far is on disk. */
    flushed(): Promise<void> { return this.#writing; }

    get enabled(): boolean { return this.#data.enabled; }

    attach(clientId: string, client: LockClient): void {
        this.#clients.set(clientId, { client, unlocked: false, server: this.#serverFor(client) });
    }

    detach(clientId: string): void {
        this.#clients.delete(clientId);
    }

    /** Locked: the lock is on and this client has not unlocked. A client the lock does not know is locked while it is on. */
    isLocked(clientId: string): boolean {
        if (!this.#data.enabled) return false;
        return !(this.#clients.get(clientId)?.unlocked ?? false);
    }

    status(clientId: string): PasskeyLockStatus {
        const rpId = this.#clients.get(clientId)?.client.rpId ?? null;
        const devices = this.#data.credentials.length;
        const canUnlock = this.#data.enabled && rpId !== null && this.#data.credentials.some((c) => c.rpId === rpId);
        return { enabled: this.#data.enabled, locked: this.isLocked(clientId), devices, canUnlock, ...(this.#damaged ? { damaged: true as const } : {}) };
    }

    onChange(listener: (clientIds: readonly string[]) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** One of the lock's methods for this client. What a locked client may call is the core table's, and nothing else. */
    async call(clientId: string, method: string, args: unknown[]): Promise<unknown> {
        if (!isPasskeyLockMethod(method)) throw new PasskeyLockError('bad-request', `${method} is not a passkey lock method`);
        if (this.isLocked(clientId) && !LOCKED_ALLOWED.has(method)) throw new PasskeyLockError('locked', 'this Genie is locked: unlock it with a passkey first');
        switch (method) {
            case 'passkeyLock.status': return this.status(clientId);
            case 'passkeyLock.lockNow': this.#setUnlocked(clientId, false); return this.status(clientId);
            case 'passkeyLock.beginUnlock': return this.#beginUnlock(clientId);
            case 'passkeyLock.finishUnlock': return this.#finishUnlock(clientId, args[0], args[1]);
            case 'passkeyLock.beginEnroll': return this.#beginEnroll(clientId);
            case 'passkeyLock.finishEnroll': return this.#finishEnroll(clientId, args[0], args[1], args[2]);
            case 'passkeyLock.disable': return this.#disable();
            case 'passkeyLock.devices': return this.#devices();
            case 'passkeyLock.removeDevice': return this.#removeDevice(args[0]);
        }
    }

    #serverFor(client: LockClient): PasskeyServer | null {
        if (client.rpId === null) return null;
        const relyingParty = new RelyingParty({
            id: client.rpId,
            name: 'Genie',
            // This client's origin now, at every verification; none known = no list, and the ceremony is refused.
            origins: () => { const o = client.origin(); if (o === null) throw new PasskeyLockError('no-origin', 'this client has no origin a passkey can be checked against'); return [o]; },
        });
        return new PasskeyServer({
            relyingParty,
            challenges: new InMemoryChallengeStore({ now: this.#now }),
            credentials: this.#credentialsFor(client.rpId),
            now: this.#now,
            policy: { userVerification: 'required', counterPolicy: 'reject' },
        });
    }

    #state(clientId: string): ClientState & { server: PasskeyServer } {
        const state = this.#clients.get(clientId);
        if (!state) throw new PasskeyLockError('bad-request', 'this client is not known to the lock');
        if (!state.server || state.client.origin() === null) throw new PasskeyLockError('no-origin', 'this client has no origin a passkey can be checked against');
        return state as ClientState & { server: PasskeyServer };
    }

    async #ceremony<T>(run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (error) {
            if (error instanceof PasskeyLockError) throw error;
            if (error instanceof PasskeyError) throw new PasskeyLockError('passkey', `the passkey was not accepted (${error.wireCode})`);
            if (error instanceof TypeError) throw new PasskeyLockError('passkey', `the passkey was not accepted (${error.message})`);
            throw error;
        }
    }

    async #beginUnlock(clientId: string): Promise<unknown> {
        if (!this.#data.enabled) throw new PasskeyLockError('not-enabled', 'the passkey lock is off');
        const { server } = this.#state(clientId);
        return this.#ceremony(() => server.startAuthentication({ userHandle: this.#data.userHandle }));
    }

    async #finishUnlock(clientId: string, state: unknown, response: unknown): Promise<unknown> {
        if (!this.#data.enabled) throw new PasskeyLockError('not-enabled', 'the passkey lock is off');
        if (typeof state !== 'string' || !isRecord(response)) throw new PasskeyLockError('bad-request', 'finishUnlock takes the ceremony state and the passkey response');
        const { server } = this.#state(clientId);
        const done = await this.#ceremony(() => server.finishAuthentication({ state, response: response as never }));
        // A credential once seen going backwards stays suspect: it unlocks nothing until it is removed and enrolled again.
        if (done.credential.clonedAt !== null) throw new PasskeyLockError('passkey', 'this passkey was marked as possibly copied; remove it and enroll the device again');
        this.#setUnlocked(clientId, true);
        return { locked: false };
    }

    async #beginEnroll(clientId: string): Promise<unknown> {
        const { server } = this.#state(clientId);
        return this.#ceremony(() => server.startRegistration({ handle: this.#data.userHandle, name: 'owner', displayName: 'Genie' }));
    }

    async #finishEnroll(clientId: string, state: unknown, response: unknown, name: unknown): Promise<unknown> {
        if (typeof state !== 'string' || !isRecord(response)) throw new PasskeyLockError('bad-request', 'finishEnroll takes the ceremony state and the passkey response');
        const label = typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 80) : this.#clients.get(clientId)?.client.label ?? 'a device';
        const { server } = this.#state(clientId);
        const done = await this.#ceremony(() => server.finishRegistration({ state, response: response as never, name: label }));
        const turningOn = !this.#data.enabled;
        if (turningOn) {
            this.#data = { ...this.#data, enabled: true };
            await this.#save();
            // This client proved a passkey; every other client has proved nothing.
            for (const [id, s] of this.#clients) s.unlocked = id === clientId;
            this.#emit([...this.#clients.keys()]);
        }
        return { enabled: true, device: toPasskeySummary(done.credential) };
    }

    async #disable(): Promise<unknown> {
        this.#data = { ...this.#data, enabled: false };
        await this.#save();
        for (const s of this.#clients.values()) s.unlocked = false;
        this.#emit([...this.#clients.keys()]);
        return { enabled: false };
    }

    #devices(): Array<PasskeySummary & { rpId: string }> {
        return this.#data.credentials.map((c) => ({ ...toPasskeySummary(c), rpId: c.rpId }));
    }

    async #removeDevice(id: unknown): Promise<boolean> {
        if (typeof id !== 'string') throw new PasskeyLockError('bad-request', 'removeDevice takes a device id');
        if (!this.#data.credentials.some((c) => c.id === id)) return false;
        if (this.#data.enabled && this.#data.credentials.length === 1) throw new PasskeyLockError('last-device', 'this is the last passkey: turn the lock off first, or nothing could unlock Genie');
        this.#data = { ...this.#data, credentials: this.#data.credentials.filter((c) => c.id !== id) };
        await this.#save();
        return true;
    }

    #setUnlocked(clientId: string, unlocked: boolean): void {
        const s = this.#clients.get(clientId);
        if (!s || s.unlocked === unlocked) return;
        s.unlocked = unlocked;
        this.#emit([clientId]);
    }

    #emit(ids: readonly string[]): void {
        for (const l of this.#listeners) l(ids);
    }

    /** One relying party's view of the credentials; ids are unique across all of them. */
    #credentialsFor(rpId: string): CredentialStore {
        const self = this;
        const copy = (c: Credential): StoredCredential => { const { rpId: _rp, ...rest } = c; return { ...rest, transports: [...rest.transports] }; };
        const update = async (id: string, change: (c: Credential) => Credential) => {
            self.#data = { ...self.#data, credentials: self.#data.credentials.map((c) => (c.id === id ? change(c) : c)) };
            await self.#save();
        };
        return {
            findById: async (id) => { const c = self.#data.credentials.find((x) => x.id === id && x.rpId === rpId); return c ? copy(c) : null; },
            findByUserHandle: async (handle) => self.#data.credentials.filter((c) => c.userHandle === handle && c.rpId === rpId).map(copy),
            save: async (credential) => {
                if (self.#data.credentials.some((c) => c.id === credential.id)) throw PasskeyError.credentialAlreadyRegistered();
                self.#data = { ...self.#data, credentials: [...self.#data.credentials, { ...credential, transports: [...credential.transports], rpId }] };
                await self.#save();
            },
            updateAfterAuthentication: (id, signCount, lastUsedAt) => update(id, (c) => ({ ...c, signCount, lastUsedAt })),
            flagCloned: (id, clonedAt) => update(id, (c) => ({ ...c, clonedAt })),
            delete: async (id) => { self.#data = { ...self.#data, credentials: self.#data.credentials.filter((c) => c.id !== id) }; await self.#save(); },
        };
    }

    /** Written whole, to a temporary file renamed over the old one, one write after another. */
    #save(): Promise<void> {
        if (this.#damaged) return Promise.reject(new PasskeyLockError('locked', 'the passkey lock file could not be read; it is left as it is'));
        const text = `${JSON.stringify(this.#data, null, 2)}\n`;
        const file = this.#file;
        const next = this.#writing.then(async () => {
            await mkdir(dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await writeFile(tmp, text, 'utf8');
            await rename(tmp, file);
        });
        this.#writing = next.catch(() => {});
        return next;
    }
}
