import {
    derivePublicKey,
    isPlausibleSealedBox,
    seal,
    sealOpen,
    sealOpenText,
    type EncryptionKeypair,
} from './sealed-box';

/**
 * The per-owner ESCROW key hierarchy for managed agent credentials (design brief
 * `.ai/_discovery/tynn-managed-agent-auth-w2-crypto.md`, "Cross-host escrow").
 *
 * Credentials are NOT sealed to each host directly — they are sealed to the
 * owner's **escrow public key**. The escrow PRIVATE key is distributed to each
 * authorised host by sealing it to *that host's* public key, so Tynn stores only
 * ciphertext at every level and can open nothing.
 *
 * A host at use time therefore performs a two-step open:
 *
 *   1. open `escrow_priv` sealed-to-this-host's-pubkey  → the escrow keypair
 *   2. open each credential sealed-to-escrow-pubkey     → plaintext IN MEMORY ONLY
 *
 * That indirection is what lets a **re-provisioned host** (fresh keypair, so it
 * can open none of the old boxes) recover: a live peer re-wraps `escrow_priv` to
 * the new pubkey and the UNCHANGED credential ciphertexts open again.
 *
 * Nothing here logs, returns, or throws with a plaintext value. A failure is
 * reported as a provider NAME on `failed[]`; the value simply never materialises.
 */

/**
 * A credential is described by THREE independent dimensions, not one slug
 * (Tynn's `ProviderCredential`):
 *
 * - `provider` — whose credential it is (`github` / `anthropic` / `openai`);
 * - `kind` — **how the host materializes it** (`api_key` → an env var;
 *   `subscription` → the Claude CLI's own credential file);
 * - `scope` — `account`, or `project` with a `projectId`.
 *
 * They are genuinely independent: `anthropic` has both an `api_key` and a
 * `subscription` form that materialize completely differently, and one provider
 * can have several live credentials at once (an account default plus a
 * project override). A flat slug can express none of that — which is also why
 * write-back keys on the credential `id` rather than the provider.
 */
export const GITHUB = 'github';
export const ANTHROPIC = 'anthropic';
export const OPENAI = 'openai';

export const API_KEY = 'api_key';
export const SUBSCRIPTION = 'subscription';

export const SCOPE_ACCOUNT = 'account';
export const SCOPE_PROJECT = 'project';

/** Which key opens a credential: the owner's escrow key (normal) or this host's
 *  own key (sealed directly to us — e.g. a first-host handoff). */
export type SealedTo = 'escrow' | 'host';

/** The owner's escrow key as Tynn serves it to ONE host. */
export interface EscrowBundle {
    /** Raw 32-byte X25519 public key, base64 — what credentials are sealed to. */
    publicKeyB64: string;
    /** The escrow PRIVATE key sealed to THIS host's public key, or null when this
     *  host hasn't been bootstrapped yet (awaiting a peer / the owner's browser). */
    wrappedPrivateKeyB64: string | null;
}

export interface SealedCredential {
    /** Tynn's credential id — the write-back key. Unambiguous where a provider
     *  name is not: an account and a project credential share a provider. */
    id: string;
    provider: string;
    kind: string;
    scope?: string;
    projectId?: string | null;
    label?: string | null;
    /** Which key opens `ciphertext`. Absent ⇒ escrow (the normal case). */
    sealedTo?: SealedTo;
    ciphertext: string;
    updatedAt?: string;
}

export interface CredentialBundle {
    escrow: EscrowBundle;
    credentials: SealedCredential[];
}

export type OpenBundleStatus = 'ok' | 'no-escrow-key';

/** One opened credential: its descriptor plus the plaintext, in memory only. */
export interface OpenedCredential {
    id: string;
    provider: string;
    kind: string;
    scope: string;
    projectId: string | null;
    label: string | null;
    /** Plaintext. Never persisted, never logged, never put in a summary. */
    value: string;
}

export interface OpenedCredentials {
    status: OpenBundleStatus;
    /** Echoed so a rotation write-back seals to the SAME escrow key it opened. */
    escrowPublicKeyB64: string;
    credentials: OpenedCredential[];
    /** Credential IDs whose ciphertext did not open — IDS ONLY, never values. */
    failed: string[];
}

/**
 * Open the escrow keypair from `bundle`, using this host's own keypair. Returns
 * null when no wrapped copy exists (bootstrap pending), when the copy was sealed
 * to a DIFFERENT host, or when the recovered private key does not match the
 * advertised escrow public key (a store handing over a mismatched pair).
 */
export async function openEscrowKeypair(
    escrow: EscrowBundle,
    hostKeypair: EncryptionKeypair,
): Promise<EncryptionKeypair | null> {
    if (!escrow?.wrappedPrivateKeyB64 || !escrow.publicKeyB64) return null;

    const opened = await sealOpen(escrow.wrappedPrivateKeyB64, hostKeypair);
    if (!opened) return null;

    const privateKeyB64 = Buffer.from(opened).toString('base64');
    // Integrity: the recovered half MUST derive to the public key we were told to
    // seal against, else every later open/write-back would target the wrong key.
    if ((await derivePublicKey(privateKeyB64)) !== escrow.publicKeyB64) return null;

    return { publicKeyB64: escrow.publicKeyB64, privateKeyB64 };
}

/**
 * The full host-side open: escrow key first, then every credential. Plaintext
 * exists only in the returned object, only in memory, and only for as long as the
 * caller holds it.
 */
export async function openCredentialBundle(
    bundle: CredentialBundle,
    hostKeypair: EncryptionKeypair,
): Promise<OpenedCredentials> {
    const escrowKeypair = await openEscrowKeypair(bundle.escrow, hostKeypair);
    const escrowPublicKeyB64 = bundle.escrow?.publicKeyB64 ?? '';

    const credentials: OpenedCredential[] = [];
    const failed: string[] = [];
    for (const credential of bundle.credentials ?? []) {
        // A `host`-sealed credential opens with our OWN key, so it is available
        // even while the escrow bootstrap is still pending. Missing the escrow
        // key is not a reason to drop something we can already open.
        const keypair = credential.sealedTo === 'host' ? hostKeypair : escrowKeypair;
        // Shape-check first: anything that could be plaintext is treated as a
        // store fault and dropped without an open attempt.
        const plaintext =
            keypair && isPlausibleSealedBox(credential.ciphertext)
                ? await sealOpenText(credential.ciphertext, keypair)
                : null;
        if (plaintext == null) {
            failed.push(credential.id);
            continue;
        }
        credentials.push({
            id: credential.id,
            provider: credential.provider,
            kind: credential.kind,
            scope: credential.scope ?? SCOPE_ACCOUNT,
            projectId: credential.projectId ?? null,
            label: credential.label ?? null,
            value: plaintext,
        });
    }
    return {
        status: escrowKeypair ? 'ok' : 'no-escrow-key',
        escrowPublicKeyB64,
        credentials,
        failed,
    };
}

/**
 * Seal a rotated value for write-back. Sealed to the ESCROW public key — NOT to
 * this host — so every authorised host, including ones provisioned later, can
 * open the rotated credential.
 */
export async function sealForEscrow(plaintext: string, escrowPublicKeyB64: string): Promise<string> {
    if (!plaintext) throw new Error('Refusing to seal an empty credential value.');
    return seal(plaintext, escrowPublicKeyB64);
}

/**
 * New-host bootstrap: wrap the escrow PRIVATE key for a peer host by sealing it
 * to that peer's public key. Only that peer can open it; Tynn just relays the
 * ciphertext. This is how a re-provisioned host regains access without any
 * plaintext credential moving and without the owner doing anything.
 */
export async function wrapEscrowForPeer(
    escrowKeypair: EncryptionKeypair,
    peerPublicKeyB64: string,
): Promise<string> {
    return seal(Buffer.from(escrowKeypair.privateKeyB64, 'base64'), peerPublicKeyB64);
}
