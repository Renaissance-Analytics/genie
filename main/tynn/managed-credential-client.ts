import { isPlausibleSealedBox } from '../host-core/crypto/sealed-box';
import type { CredentialBundle, SealedCredential } from '../host-core/crypto/escrow';
import type {
    CredentialRevoke,
    ManagedCredentialClient,
} from '../host-core/crypto/managed-credentials';
import type { EncryptionKeyPublisher } from '../host-core/crypto/host-encryption-key';
import type { PusherFrame } from './pusher-protocol';

/**
 * The Tynn transport for managed agent credentials — the only place this repo
 * knows the wire shape of that API.
 *
 * Everything it moves is **ciphertext or a public key**. It rides the existing
 * `Authorization: Workstation <ts>:<sig>` Ed25519 host proof (same header
 * `local-workstation.ts` already signs inventory/issue-watch calls with), so
 * there is no new auth surface — the signing identity proves *which* host is
 * asking, and the separate X25519 encryption key decides what that host can
 * actually open.
 *
 * Two deliberate guards:
 * - **`putCredential` refuses anything that isn't a plausible sealed box.** The
 *   host is the last checkpoint before a value leaves the process; a bug that
 *   handed it plaintext must fail here rather than write plaintext into the
 *   zero-knowledge store.
 * - **HTTP errors never quote the response body**, which could echo a value back.
 */

/** The Ed25519 host proof source — `readWorkstationIdentity()` satisfies it. */
export interface HostSigner {
    workstationId: string;
    authHeader(): string;
}

/** Thrown for a non-2xx. Carries the status and the operation NAME only. */
export class ManagedCredentialHttpError extends Error {
    constructor(
        readonly status: number,
        operation: string,
    ) {
        super(`Tynn managed-credential ${operation} failed with HTTP ${status}`);
        this.name = 'ManagedCredentialHttpError';
    }
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/** Coerce Tynn's snake_case bundle into the host shape. Unusable rows are
 *  dropped rather than half-parsed — a credential with no ciphertext is nothing. */
export function parseCredentialBundle(raw: unknown): CredentialBundle {
    const root = (raw ?? {}) as Record<string, unknown>;
    const escrowRaw = (root.escrow ?? {}) as Record<string, unknown>;
    const credentials: SealedCredential[] = [];
    for (const row of Array.isArray(root.credentials) ? root.credentials : []) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const provider = str(r.provider);
        const ciphertext = str(r.ciphertext);
        if (!provider || !ciphertext) continue;
        credentials.push({
            ...(str(r.id) ? { id: str(r.id)! } : {}),
            provider,
            ciphertext,
            ...(str(r.updated_at) ? { updatedAt: str(r.updated_at)! } : {}),
        });
    }
    return {
        escrow: {
            publicKeyB64: str(escrowRaw.public_key) ?? '',
            wrappedPrivateKeyB64: str(escrowRaw.wrapped_private_key),
        },
        credentials,
    };
}

/**
 * Build the host-authed client. `fetchImpl` is injected (defaults to global
 * `fetch`) so this stays testable and cookie-free — a host proves itself with the
 * signature header, never a session.
 */
export function createManagedCredentialClient(
    identity: HostSigner,
    tynnApiBaseUrl: string,
    fetchImpl: typeof fetch = fetch,
): ManagedCredentialClient & EncryptionKeyPublisher {
    const base = tynnApiBaseUrl.replace(/\/+$/, '');
    const ws = encodeURIComponent(identity.workstationId);

    async function call(
        method: string,
        path: string,
        operation: string,
        body?: unknown,
    ): Promise<unknown> {
        const res = await fetchImpl(`${base}${path}`, {
            method,
            headers: {
                accept: 'application/json',
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                authorization: identity.authHeader(),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        // Deliberately does NOT read/quote the body — an error response could
        // echo back a value we sent.
        if (!res.ok) throw new ManagedCredentialHttpError(res.status, operation);
        return res.json();
    }

    return {
        async publishEncryptionKey({ publicKeyB64, fingerprint }) {
            await call('POST', `/api/v1/workstations/${ws}/encryption-key`, 'publish encryption key', {
                encryption_public_key: publicKeyB64,
                fingerprint,
            });
        },

        async fetchBundle() {
            return parseCredentialBundle(
                await call('GET', `/api/v1/workstations/${ws}/credentials`, 'fetch bundle'),
            );
        },

        async putCredential(provider, ciphertextB64) {
            // Last checkpoint before a value leaves the process. Tynn is a
            // zero-knowledge store; writing anything openable into it is a bug we
            // refuse to commit rather than report afterwards.
            if (!isPlausibleSealedBox(ciphertextB64)) {
                throw new Error(
                    `Refusing to write ${provider}: the payload is not a sealed-box ciphertext.`,
                );
            }
            await call(
                'PUT',
                `/api/v1/workstations/${ws}/credentials/${encodeURIComponent(provider)}`,
                'write back credential',
                { ciphertext: ciphertextB64 },
            );
        },

        async listEscrowPending() {
            const raw = (await call(
                'GET',
                '/api/v1/workstations/escrow/pending',
                'list escrow pending',
            )) as { hosts?: unknown };
            const rows = Array.isArray(raw?.hosts) ? raw.hosts : [];
            const pending: Array<{ workstationId: string; encryptionPublicKeyB64: string }> = [];
            for (const row of rows) {
                if (!row || typeof row !== 'object') continue;
                const r = row as Record<string, unknown>;
                const workstationId = str(r.workstation_id);
                const encryptionPublicKeyB64 = str(r.encryption_public_key);
                // No published key ⇒ nothing to seal to. Skip rather than guess.
                if (!workstationId || !encryptionPublicKeyB64) continue;
                pending.push({ workstationId, encryptionPublicKeyB64 });
            }
            return pending;
        },

        async wrapEscrowForHost({ targetWorkstationId, wrappedPrivateKeyB64 }) {
            await call('POST', '/api/v1/workstations/escrow/wrap', 'wrap escrow for host', {
                target_workstation_id: targetWorkstationId,
                wrapped_private_key: wrappedPrivateKeyB64,
            });
        },
    };
}

/**
 * Is this a `credential.revoked` push for OUR workstation channel? Revocation
 * rides the SAME private `workstation.{id}` channel as `issuewatch.delta` and
 * `WorkspaceAssigned` — one socket, no new transport, no polling.
 */
export function isCredentialRevoke(frame: PusherFrame, channel: string): boolean {
    return frame.event === 'credential.revoked' && frame.channel === channel;
}

/**
 * Coerce an untrusted revoke payload. Null when it names nothing usable — a
 * malformed push must revoke NOTHING rather than guess, since guessing "all"
 * would un-authenticate the whole host on a garbled frame.
 */
export function toCredentialRevoke(raw: unknown): CredentialRevoke | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.all === true) return { all: true };
    const provider = str(r.provider);
    return provider ? { provider } : null;
}
