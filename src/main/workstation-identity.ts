import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * THIS MACHINE AS A TYNN WORKSTATION (Tynn #836) — Genie 1's Tynn network, as it was
 * (`v1:main/tynn/workstation-identity.ts`; the owner, 2026-10-19: "Port Tynn network").
 *
 * A signed-in Genie self-registers this machine with Tynn (`POST /api/v1/workstations/self-register`, free), makes an
 * Ed25519 key, and enrolls its PUBLIC half with the one-time secret Tynn handed back (`POST …/{id}/enroll`). From then
 * on it proves it is this workstation with `Authorization: Workstation <ts>:<sig>` over `workstation-auth\n{id}\n{ts}` —
 * byte for byte what Tynn's `EnsureWorkstationHost` and genie-cloud's host signer use. The relay host (#838) signs its
 * hello with the same key.
 *
 * One identity per Tynn host (tynn.ai and a dev Tynn are different workstations). The private key is stored only after
 * enroll succeeds, and only encrypted (Electron's safeStorage, passed in); without OS encryption nothing is written.
 */

/** Domain separator — MUST match Tynn's `EnsureWorkstationHost::PROOF_CONTEXT` and genie-cloud's host-auth. */
const PROOF_CONTEXT = 'workstation-auth';

/** Domain separator of a re-attach proof — MUST match Tynn's `WorkstationMachineIdentity::PROOF_CONTEXT` (genie#1278). */
const REATTACH_CONTEXT = 'workstation-reattach';

/** Proof this Genie holds `workstationId`'s enrolled key: Ed25519 over `workstation-reattach\n{id}\n{ts}`. */
export function buildReattachProof(privateKeyPem: string, workstationId: string, now: number = Date.now()): { workstation_id: string; ts: number; sig: string } {
    const ts = Math.floor(now / 1000);
    const sig = sign(null, Buffer.from(`${REATTACH_CONTEXT}\n${workstationId}\n${ts}`, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
    return { workstation_id: workstationId, ts, sig };
}

export interface HostKeypair {
    /** PKCS8 PEM — signed with, stored encrypted. */
    readonly privateKeyPem: string;
    /** SPKI DER, base64 — the `host_public_key` Tynn enrolls. */
    readonly publicKeySpkiB64: string;
}

export function generateHostKeypair(): HostKeypair {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicKeySpkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
}

/** SHA-256 (hex) of the SPKI DER public key — the `host_fingerprint` Tynn records. */
export function fingerprintSpki(publicKeySpkiB64: string): string {
    return createHash('sha256').update(Buffer.from(publicKeySpkiB64, 'base64')).digest('hex');
}

/** `Workstation <ts>:<sig>` for `workstationId`; Tynn accepts ±300 s. */
export function buildWorkstationAuthHeader(privateKeyPem: string, workstationId: string, now: number = Date.now()): string {
    const ts = Math.floor(now / 1000);
    // Ed25519 is pure EdDSA: the algorithm MUST be null.
    const sig = sign(null, Buffer.from(`${PROOF_CONTEXT}\n${workstationId}\n${ts}`, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
    return `Workstation ${ts}:${sig}`;
}

export interface StoredIdentity {
    readonly workstationId: string;
    readonly privateKeyPem: string;
}

export interface WorkstationIdentity {
    readonly workstationId: string;
    authHeader(now?: number): string;
    /** Signs with the enrolled key — the relay host's hello (#838). Callers never hold the key. */
    sign(data: Buffer): Buffer;
    readonly fingerprint: string;
}

export function identityFrom(stored: StoredIdentity): WorkstationIdentity {
    const key = createPrivateKey(stored.privateKeyPem);
    const spki = (createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    return {
        workstationId: stored.workstationId,
        authHeader: (now = Date.now()) => buildWorkstationAuthHeader(stored.privateKeyPem, stored.workstationId, now),
        sign: (data) => sign(null, data, key),
        fingerprint: fingerprintSpki(spki),
    };
}

/** Where identities live, per Tynn host. */
export interface IdentityStore {
    /** Can a key be stored at all (OS encryption)? Asked BEFORE Tynn is (Tynn #847). */
    canWrite(): boolean;
    read(host: string): Promise<StoredIdentity | null>;
    write(host: string, identity: StoredIdentity): Promise<void>;
    /** The Genie 1 record already settled with this Tynn (genie#1278 adopt), or null. */
    legacyDone?(host: string): Promise<string | null>;
    markLegacyDone?(host: string, workstationId: string): Promise<void>;
}

/** The record GENIE 1 registered for this machine (its genie.db), and its key when this Genie can decrypt it. */
export interface LegacyIdentity {
    readonly workstationId: string;
    readonly privateKeyPem: string | null;
}

/** STUB (red first). */
export function readGenie1Identity(_settings: Readonly<Record<string, string>> | null, _cipher: IdentityCipher): LegacyIdentity | null {
    throw new Error('not implemented');
}

/** Electron's safeStorage, as a port. */
export interface IdentityCipher {
    isAvailable(): boolean;
    encrypt(text: string): Buffer;
    decrypt(bytes: Buffer): string;
}

type IdentityFile = Record<string, { workstationId: string; keyEnc: string }>;

/** The identities file: the workstation id in the clear, the private key encrypted; fail closed. */
export function workstationKeyStore(file: string, cipher: IdentityCipher): IdentityStore {
    const load = async (): Promise<IdentityFile> => {
        try {
            const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
            return parsed && typeof parsed === 'object' ? (parsed as IdentityFile) : {};
        } catch {
            return {};
        }
    };
    return {
        canWrite: () => cipher.isAvailable(),
        async read(host) {
            const row = (await load())[host];
            if (!row?.workstationId || !row.keyEnc) return null;
            try {
                const privateKeyPem = cipher.decrypt(Buffer.from(row.keyEnc, 'base64'));
                createPrivateKey(privateKeyPem);
                return { workstationId: row.workstationId, privateKeyPem };
            } catch {
                // Another OS user's keychain, or a damaged file: not registered, so the next ensure enrolls afresh.
                return null;
            }
        },
        async write(host, identity) {
            if (!cipher.isAvailable()) {
                throw new Error('OS encryption is unavailable; refusing to store the workstation key unencrypted (on Linux, install gnome-keyring / libsecret)');
            }
            const all = await load();
            all[host] = { workstationId: identity.workstationId, keyEnc: cipher.encrypt(identity.privateKeyPem).toString('base64') };
            await mkdir(dirname(file), { recursive: true });
            const tmp = `${file}.tmp`;
            await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
            await rename(tmp, file);
        },
    };
}

type TynnRequest = (path: string, init: { method: 'GET' | 'POST'; body?: unknown }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface EnsureWorkstationPorts {
    /** The Tynn host, read at call time. */
    readonly host: () => string;
    /** The name Tynn shows — the machine's hostname. */
    readonly hostname: () => string;
    /** TynnAccount.request: the signed-in session. */
    readonly request: TynnRequest;
    readonly store: IdentityStore;
    readonly generate?: () => HostKeypair;
    /** This machine's stable key (machine-key.ts), or null when the OS gives no machine id (genie#1278 W2). */
    readonly machineKey?: () => Promise<string | null>;
    /** Genie 1's record of this machine (genie#1278 adopt on sign-in), or null. */
    readonly legacy?: () => Promise<LegacyIdentity | null>;
    readonly now?: () => number;
}

export type EnsureWorkstationResult =
    | { readonly ok: true; readonly status: 'exists' | 'enrolled'; readonly workstationId: string }
    | { readonly ok: false; readonly reason: string };

const refusal = async (what: string, res: { status: number; json(): Promise<unknown> }): Promise<string> => {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    return `Tynn refused to ${what} (${res.status}${typeof body?.message === 'string' && body.message ? `: ${body.message}` : ''})`;
};

/**
 * Registered with this Tynn already and Tynn says this pairing IS that workstation → nothing else asked. Registered, but
 * this pairing is not bound to it (a new sign-in is a new Tynn device) → self-register again with the machine key and
 * proof of the enrolled key, which binds this pairing and keeps the role. Not registered → self-register (with the
 * machine key, so Tynn finds this machine's record if it has one) → key → enroll → store, in that order.
 */
export async function ensureWorkstation(ports: EnsureWorkstationPorts): Promise<EnsureWorkstationResult> {
    const host = ports.host();
    const existing = await ports.store.read(host);
    const machineKey = await (ports.machineKey?.() ?? Promise.resolve(null)).catch(() => null);
    if (existing) {
        const me = await ports.request('/api/v1/workstations/me', { method: 'GET' }).catch(() => null);
        const body = me?.ok ? ((await me.json().catch(() => null)) as { workstation?: { id?: unknown } | null } | null) : null;
        // Tynn cannot say (signed out, offline): keep the identity; the next sign-in asks again.
        if (!me?.ok || body === null) return { ok: true, status: 'exists', workstationId: existing.workstationId };
        if (body.workstation?.id === existing.workstationId) return { ok: true, status: 'exists', workstationId: existing.workstationId };
        const proved = await ports.request('/api/v1/workstations/self-register', {
            method: 'POST',
            body: { name: ports.hostname(), ...(machineKey ? { machine_key: machineKey } : {}), proof: buildReattachProof(existing.privateKeyPem, existing.workstationId, (ports.now ?? Date.now)()) },
        });
        if (!proved.ok) return { ok: false, reason: await refusal('re-attach this machine', proved) };
        const answer = (await proved.json().catch(() => null)) as { workstation?: { id?: unknown }; enrollment?: { workstation_id?: unknown; secret?: unknown } | null } | null;
        if (!answer?.enrollment && answer?.workstation?.id === existing.workstationId) return { ok: true, status: 'exists', workstationId: existing.workstationId };
        return enrollAndStore(ports, host, answer);
    }

    // Without OS encryption the key could not be kept: ask Tynn NOTHING, or it holds an enrolled, keyless workstation
    // after every attempt (the two-VM proof, 2026-10-20; Tynn #847).
    if (!ports.store.canWrite()) return { ok: false, reason: 'this machine cannot encrypt a key (no OS keyring answering), so it is not registered with Tynn' };
    const registered = await ports.request('/api/v1/workstations/self-register', { method: 'POST', body: { name: ports.hostname(), ...(machineKey ? { machine_key: machineKey } : {}) } });
    // Tynn answers an unauthenticated session route 404 (tynn.ai#303), 401/419 before that.
    if (registered.status === 401 || registered.status === 404 || registered.status === 419) return { ok: false, reason: 'sign in to Tynn to register this machine' };
    if (!registered.ok) return { ok: false, reason: await refusal('register this machine', registered) };
    return enrollAndStore(ports, host, (await registered.json()) as { enrollment?: { workstation_id?: unknown; secret?: unknown } | null } | null);
}

/** A fresh key, enrolled with the one-time secret Tynn handed back, then stored (encrypted) — in that order. */
async function enrollAndStore(ports: EnsureWorkstationPorts, host: string, grant: { enrollment?: { workstation_id?: unknown; secret?: unknown } | null } | null): Promise<EnsureWorkstationResult> {
    const workstationId = grant?.enrollment?.workstation_id;
    const secret = grant?.enrollment?.secret;
    if (typeof workstationId !== 'string' || typeof secret !== 'string') return { ok: false, reason: 'Tynn answered the registration without an enrollment' };

    const pair = (ports.generate ?? generateHostKeypair)();
    const enrolled = await ports.request(`/api/v1/workstations/${encodeURIComponent(workstationId)}/enroll`, {
        method: 'POST',
        body: { enrollment_secret: secret, host_public_key: pair.publicKeySpkiB64, host_fingerprint: fingerprintSpki(pair.publicKeySpkiB64) },
    });
    if (!enrolled.ok) return { ok: false, reason: await refusal('enroll this machine', enrolled) };

    try {
        await ports.store.write(host, { workstationId, privateKeyPem: pair.privateKeyPem });
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, status: 'enrolled', workstationId };
}
