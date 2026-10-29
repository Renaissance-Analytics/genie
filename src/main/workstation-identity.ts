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

/**
 * GENIE 1'S RECORD OF THIS MACHINE (genie#1278 adopt on sign-in): `settings.workstation_id` and `workstation_key_enc` in
 * Genie 1's genie.db (`v1:main/tynn/workstation-identity.ts` ID_KEY / KEY_ENC_KEY), under the userData Genie 2 shares.
 * The key was encrypted by Genie 1's safeStorage; the same userData means the same OS key, so this Genie can usually
 * decrypt it (measured for the GitHub carry-over). When it cannot, the id alone: Tynn then never hands back more than
 * a Drone for it.
 */
export function readGenie1Identity(settings: Readonly<Record<string, string>> | null, cipher: IdentityCipher): LegacyIdentity | null {
    const workstationId = settings?.['workstation_id']?.trim() ?? '';
    if (workstationId === '') return null;
    const enc = settings?.['workstation_key_enc'] ?? '';
    let privateKeyPem: string | null = null;
    if (enc !== '' && cipher.isAvailable()) {
        try {
            const pem = cipher.decrypt(Buffer.from(enc, 'base64'));
            createPrivateKey(pem);
            privateKeyPem = pem;
        } catch {
            // Another OS user's keychain, or not a key: the id alone.
        }
    }
    return { workstationId, privateKeyPem };
}

/** Electron's safeStorage, as a port. */
export interface IdentityCipher {
    isAvailable(): boolean;
    encrypt(text: string): Buffer;
    decrypt(bytes: Buffer): string;
}

type IdentityFile = Record<string, { workstationId?: string; keyEnc?: string; legacyDone?: string }>;

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
            // A new key keeps what else this host's row says (the Genie 1 record already settled).
            all[host] = { ...all[host], workstationId: identity.workstationId, keyEnc: cipher.encrypt(identity.privateKeyPem).toString('base64') };
            await save(all);
        },
        async legacyDone(host) {
            const done = (await load())[host]?.legacyDone;
            return typeof done === 'string' && done !== '' ? done : null;
        },
        async markLegacyDone(host, workstationId) {
            const all = await load();
            all[host] = { ...all[host], legacyDone: workstationId };
            await save(all);
        },
    };
    async function save(all: IdentityFile): Promise<void> {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
        await rename(tmp, file);
    }
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
    const legacy = await pendingLegacy(ports, host, existing);
    const now = ports.now ?? Date.now;
    const legacyBody = legacy
        ? { legacy: { workstation_id: legacy.workstationId, ...(legacy.privateKeyPem ? { proof: proofBody(buildReattachProof(legacy.privateKeyPem, legacy.workstationId, now())) } : {}) } }
        : {};
    if (existing && legacy) {
        // GENIE 1'S RECORD AND GENIE 2'S, ONE MACHINE (genie#1278 adopt; the owner's AlphaR): Tynn keeps one and retires
        // the other. Asked even when Tynn says this pairing IS the Genie 2 record — that is exactly the duplicate case.
        const settled = await ports.request('/api/v1/workstations/self-register', {
            method: 'POST',
            body: { name: ports.hostname(), ...(machineKey ? { machine_key: machineKey } : {}), proof: buildReattachProof(existing.privateKeyPem, existing.workstationId, now()), ...legacyBody },
        }).catch(() => null);
        // Not settled (signed out, Tynn down, refused): this machine keeps its identity; the next sign-in asks again.
        if (!settled?.ok) return { ok: true, status: 'exists', workstationId: existing.workstationId };
        const answer = (await settled.json().catch(() => null)) as { workstation?: { id?: unknown }; enrollment?: { workstation_id?: unknown; secret?: unknown } | null } | null;
        if (!answer?.enrollment && answer?.workstation?.id === existing.workstationId) {
            await markLegacy(ports, host, legacy);
            return { ok: true, status: 'exists', workstationId: existing.workstationId };
        }
        const enrolled = await enrollAndStore(ports, host, answer);
        if (enrolled.ok) await markLegacy(ports, host, legacy);
        return enrolled;
    }
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
    // Genie 1's record of this machine, when there is one: Tynn hands that record back instead of minting another.
    const registered = await ports.request('/api/v1/workstations/self-register', { method: 'POST', body: { name: ports.hostname(), ...(machineKey ? { machine_key: machineKey } : {}), ...legacyBody } });
    // Tynn answers an unauthenticated session route 404 (tynn.ai#303), 401/419 before that.
    if (registered.status === 401 || registered.status === 404 || registered.status === 419) return { ok: false, reason: 'sign in to Tynn to register this machine' };
    if (!registered.ok) return { ok: false, reason: await refusal('register this machine', registered) };
    const result = await enrollAndStore(ports, host, (await registered.json()) as { enrollment?: { workstation_id?: unknown; secret?: unknown } | null } | null);
    if (result.ok && legacy) await markLegacy(ports, host, legacy);
    return result;
}

/** Genie 1's record still to settle with this Tynn: there is one, it is not this identity, and it is not settled yet. */
async function pendingLegacy(ports: EnsureWorkstationPorts, host: string, existing: StoredIdentity | null): Promise<LegacyIdentity | null> {
    // Reading Genie 1 never blocks registering this machine.
    const legacy = await (ports.legacy?.() ?? Promise.resolve(null)).catch(() => null);
    if (!legacy || legacy.workstationId === existing?.workstationId) return null;
    const done = await (ports.store.legacyDone?.(host) ?? Promise.resolve(null)).catch(() => null);
    return done === legacy.workstationId ? null : legacy;
}

async function markLegacy(ports: EnsureWorkstationPorts, host: string, legacy: LegacyIdentity): Promise<void> {
    await ports.store.markLegacyDone?.(host, legacy.workstationId).catch(() => undefined);
}

/** Tynn's `legacy.proof`: the record is named by `legacy.workstation_id`, so only `ts` and `sig`. */
function proofBody(proof: { ts: number; sig: string }): { ts: number; sig: string } {
    return { ts: proof.ts, sig: proof.sig };
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
