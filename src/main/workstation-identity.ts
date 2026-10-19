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
    read(host: string): Promise<StoredIdentity | null>;
    write(host: string, identity: StoredIdentity): Promise<void>;
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
}

export type EnsureWorkstationResult =
    | { readonly ok: true; readonly status: 'exists' | 'enrolled'; readonly workstationId: string }
    | { readonly ok: false; readonly reason: string };

const refusal = async (what: string, res: { status: number; json(): Promise<unknown> }): Promise<string> => {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    return `Tynn refused to ${what} (${res.status}${typeof body?.message === 'string' && body.message ? `: ${body.message}` : ''})`;
};

/** Registered with this Tynn already → nothing asked. Otherwise self-register → key → enroll → store, in that order. */
export async function ensureWorkstation(ports: EnsureWorkstationPorts): Promise<EnsureWorkstationResult> {
    const host = ports.host();
    const existing = await ports.store.read(host);
    if (existing) return { ok: true, status: 'exists', workstationId: existing.workstationId };

    const registered = await ports.request('/api/v1/workstations/self-register', { method: 'POST', body: { name: ports.hostname() } });
    // Tynn answers an unauthenticated session route 404 (tynn.ai#303), 401/419 before that.
    if (registered.status === 401 || registered.status === 404 || registered.status === 419) return { ok: false, reason: 'sign in to Tynn to register this machine' };
    if (!registered.ok) return { ok: false, reason: await refusal('register this machine', registered) };
    const grant = (await registered.json()) as { enrollment?: { workstation_id?: unknown; secret?: unknown } } | null;
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
