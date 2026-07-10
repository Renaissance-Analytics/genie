import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import os from 'node:os';

import { getAllSettings, setSettings, type Settings } from '../db';
import { decryptSecret, encryptSecret, secretEncryptionAvailable } from '../secrets/store';

/**
 * Local-workstation identity — the Ed25519 keypair + Tynn workstation id a LOCAL
 * Genie self-registers as a Workstation with (design brief
 * `.ai/_discovery/genie-service-separation.md` §2a).
 *
 * A workstation is ANY Genie host, local or cloud. A local Genie SELF-REGISTERS
 * (FREE + uncapped — no GCC spawn) and then rides the EXACT host-authed channels
 * the cloud host uses. It proves possession of its private key with the SAME
 * `Authorization: Workstation <ts>:<sig>` header genie-cloud's `createHostSigner`
 * builds (`repos/genie-cloud/src/workspace-assignment/host-auth.ts`), signing the
 * bytes `workstation-auth\n{id}\n{ts}`.
 *
 * The private key never lands in plaintext on disk — it's encrypted at rest via
 * the shared secrets seam (OS-keychain-backed), exactly like the GitHub token
 * (`main/github/storage.ts`). The workstation id is stored in the clear so the
 * transport / UI can address the channel without decrypting on every read.
 */

/** Domain separator — MUST match Tynn's `EnsureWorkstationHost::PROOF_CONTEXT`
 *  and genie-cloud's host-auth `PROOF_CONTEXT`. */
const PROOF_CONTEXT = 'workstation-auth';

const ID_KEY = 'workstation_id';
const KEY_ENC_KEY = 'workstation_key_enc';

export interface HostKeypair {
    /** PKCS8 PEM — the private key we sign with + persist (encrypted). */
    privateKeyPem: string;
    /** SPKI DER, base64 — the `host_public_key` Tynn enrolls (matches genie-cloud). */
    publicKeySpkiB64: string;
}

/**
 * Generate a fresh Ed25519 host keypair. Private → PKCS8 PEM; public → SPKI DER
 * base64 — the exact `host_public_key` shape the enroll endpoint expects (mirrors
 * how genie-cloud's GCC exports the host public key).
 */
export function generateHostKeypair(): HostKeypair {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicKeySpkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
}

/** SHA-256 fingerprint (hex) of the SPKI DER public key — the optional
 *  `host_fingerprint` the enroll endpoint may record for at-a-glance integrity. */
export function fingerprintSpki(publicKeySpkiB64: string): string {
    return createHash('sha256')
        .update(Buffer.from(publicKeySpkiB64, 'base64'))
        .digest('hex');
}

/**
 * Build the `Authorization: Workstation <ts>:<sig>` header for `workstationId`,
 * signing `workstation-auth\n{id}\n{ts}` with the Ed25519 private key — byte-for-
 * byte what genie-cloud's `createHostSigner` produces, so Tynn verifies both the
 * same way (±300s freshness). `now` is injectable for deterministic tests.
 */
export function buildWorkstationAuthHeader(
    privateKeyPem: string,
    workstationId: string,
    now: number = Date.now(),
): string {
    const key = createPrivateKey(privateKeyPem);
    const ts = Math.floor(now / 1000);
    const message = Buffer.from(`${PROOF_CONTEXT}\n${workstationId}\n${ts}`, 'utf8');
    // Ed25519 is a pure EdDSA signature — the algorithm MUST be null.
    const sig = sign(null, message, key).toString('base64');
    return `Workstation ${ts}:${sig}`;
}

export interface WorkstationIdentity {
    workstationId: string;
    /** The host proof header for this workstation's own channel; `now` injectable. */
    authHeader(now?: number): string;
}

/** The persisted identity fields, read from settings. Injectable for tests. */
export type IdentityReader = () => { id?: string; keyEnc?: string };

function defaultRead(): { id?: string; keyEnc?: string } {
    const s = getAllSettings() as unknown as Record<string, string>;
    return { id: s[ID_KEY] || undefined, keyEnc: s[KEY_ENC_KEY] || undefined };
}

/**
 * Read the persisted local-workstation identity, or null when not enrolled (no id
 * stored) or the key can't be decrypted (OS encryption unavailable, or written
 * under a different keychain key after an OS user reset). The returned `authHeader`
 * closes over the decrypted key so callers never touch the PEM.
 */
export function readWorkstationIdentity(read: IdentityReader = defaultRead): WorkstationIdentity | null {
    const { id, keyEnc } = read();
    if (!id || !keyEnc) return null;
    const pem = decryptSecret(keyEnc);
    if (!pem) return null;
    return {
        workstationId: id,
        authHeader: (now: number = Date.now()) => buildWorkstationAuthHeader(pem, id, now),
    };
}

/**
 * Persist a freshly enrolled identity: the workstation id (clear) + the private
 * key PEM (encrypted at rest). FAIL CLOSED — throws when OS encryption is
 * unavailable rather than writing the key in plaintext (mirrors github storage's
 * refuse-to-write behaviour). `write` is injectable for tests.
 */
export function storeWorkstationIdentity(
    workstationId: string,
    privateKeyPem: string,
    write: (patch: Partial<Settings>) => void = (p) => void setSettings(p),
): void {
    const enc = secretEncryptionAvailable() ? encryptSecret(privateKeyPem) : null;
    if (enc == null) {
        throw new Error(
            'OS encryption is unavailable; refusing to store the workstation key unencrypted. ' +
                'On Linux, install gnome-keyring / libsecret.',
        );
    }
    write({ [ID_KEY]: workstationId, [KEY_ENC_KEY]: enc } as Partial<Settings>);
}

/** The Tynn calls `ensureLocalWorkstation` drives — a subset of `TynnBackend`, so
 *  tests inject a fake and the module stays free of the electron-bound backend. */
export interface WorkstationEnroller {
    selfRegisterWorkstation(name: string): Promise<{
        workstation: { id: string; name: string; status: string };
        enrollment: { workstation_id: string; secret: string; expires_at: string | null };
    }>;
    enrollWorkstation(
        id: string,
        enrollmentSecret: string,
        hostPublicKeyB64: string,
        fingerprint?: string,
    ): Promise<unknown>;
}

export interface EnsureLocalWorkstationResult {
    status: 'exists' | 'enrolled';
    workstationId: string;
}

/** Injectable seams for `ensureLocalWorkstation` — default to the real hostname /
 *  identity store / keypair generator so the shell calls it with just a backend. */
export interface EnsureLocalWorkstationDeps {
    hostname?: () => string;
    readIdentity?: () => WorkstationIdentity | null;
    storeIdentity?: (id: string, pem: string) => void;
    generateKeypair?: () => HostKeypair;
}

/**
 * Idempotently ensure this machine is a self-registered, enrolled Tynn Workstation
 * (design brief §2a). If an identity is already persisted → no-op (`exists`).
 * Otherwise: self-register (name = machine hostname; FREE + uncapped, no GCC
 * spawn) → generate an Ed25519 keypair → enroll the SPKI public key → persist the
 * identity (private key encrypted at rest) → `enrolled`.
 *
 * The identity is stored ONLY after enroll SUCCEEDS, so a failed enroll leaves the
 * machine cleanly un-enrolled (the next boot retries) rather than persisting an
 * un-activated key. Best-effort at the call site: the caller catches and simply
 * leaves the connected services off.
 */
export async function ensureLocalWorkstation(
    backend: WorkstationEnroller,
    deps: EnsureLocalWorkstationDeps = {},
): Promise<EnsureLocalWorkstationResult> {
    const readIdentity = deps.readIdentity ?? (() => readWorkstationIdentity());
    const existing = readIdentity();
    if (existing) return { status: 'exists', workstationId: existing.workstationId };

    const name = (deps.hostname ?? (() => os.hostname()))();
    const generate = deps.generateKeypair ?? generateHostKeypair;
    const store = deps.storeIdentity ?? storeWorkstationIdentity;

    const reg = await backend.selfRegisterWorkstation(name);
    const workstationId = reg.enrollment.workstation_id;
    const { privateKeyPem, publicKeySpkiB64 } = generate();
    await backend.enrollWorkstation(
        workstationId,
        reg.enrollment.secret,
        publicKeySpkiB64,
        fingerprintSpki(publicKeySpkiB64),
    );
    store(workstationId, privateKeyPem);
    return { status: 'enrolled', workstationId };
}
