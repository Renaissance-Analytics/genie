import { isPlausibleSealedBox } from '../host-core/crypto/sealed-box';
import {
    SCOPE_ACCOUNT,
    type CredentialBundle,
    type SealedCredential,
    type SealedTo,
} from '../host-core/crypto/escrow';
import type {
    ManagedCredentialClient,
    ProviderCredentialChange,
} from '../host-core/crypto/managed-credentials';
import type { EncryptionKeyPublisher } from '../host-core/crypto/host-encryption-key';
import type { PusherFrame } from './pusher-protocol';

/**
 * The Tynn transport for managed agent credentials — the only place this repo
 * knows the wire shape of that API.
 *
 * Everything it moves is **ciphertext or a public key**. It rides the existing
 * `Authorization: Workstation <ts>:<sig>` Ed25519 host proof, so there is no new
 * auth surface: the signing identity proves *which* host is asking, and the
 * separate X25519 encryption key decides what that host can actually open.
 *
 * **Every route is nested under `/api/v1/workstations/{id}/`.** That is not
 * cosmetic — Tynn's `EnsureWorkstationHost` verifies the signature against the
 * public key of the ROUTE-BOUND workstation, so a route with no `{workstation}`
 * segment has nothing to verify against and is rejected before the handler runs.
 * Payloads are camelCase, matching the other host-facing endpoints.
 *
 * Two deliberate guards:
 * - **`putCredential` refuses anything that isn't a plausible sealed box**, using
 *   the same structural gate Tynn applies server-side. The host is the last
 *   checkpoint before a value leaves the process; a bug that handed it plaintext
 *   must fail here rather than write plaintext into the zero-knowledge store.
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

/** Coerce Tynn's bundle into the host shape. Unusable rows are dropped rather
 *  than half-parsed — a credential with no id or ciphertext is nothing. */
export function parseCredentialBundle(raw: unknown): CredentialBundle {
    const root = (raw ?? {}) as Record<string, unknown>;
    const escrowRaw = (root.escrow ?? {}) as Record<string, unknown>;
    const credentials: SealedCredential[] = [];
    for (const row of Array.isArray(root.credentials) ? root.credentials : []) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const id = str(r.id);
        const provider = str(r.provider);
        const kind = str(r.kind);
        const ciphertext = str(r.ciphertext);
        if (!id || !provider || !kind || !ciphertext) continue;
        credentials.push({
            id,
            provider,
            kind,
            scope: str(r.scope) ?? SCOPE_ACCOUNT,
            projectId: str(r.projectId),
            label: str(r.label),
            // Absent ⇒ escrow, the normal case.
            sealedTo: (str(r.sealedTo) === 'host' ? 'host' : 'escrow') as SealedTo,
            ciphertext,
            ...(str(r.updatedAt) ? { updatedAt: str(r.updatedAt)! } : {}),
        });
    }
    return {
        escrow: {
            publicKeyB64: str(escrowRaw.publicKey) ?? '',
            wrappedPrivateKeyB64: str(escrowRaw.wrappedPrivateKey),
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
    const prefix = `${base}/api/v1/workstations/${encodeURIComponent(identity.workstationId)}`;

    async function call(
        method: string,
        path: string,
        operation: string,
        body?: unknown,
    ): Promise<unknown> {
        const res = await fetchImpl(`${prefix}${path}`, {
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
        async publishEncryptionKey({ publicKeyB64 }) {
            // Public key only. Tynn derives the fingerprint itself — one we send
            // is one it cannot verify, which is worth nothing.
            await call('POST', '/encryption-key', 'publish encryption key', { publicKey: publicKeyB64 });
        },

        async fetchBundle() {
            return parseCredentialBundle(await call('GET', '/provider-credentials', 'fetch bundle'));
        },

        async putCredential(credentialId, ciphertextB64) {
            // Last checkpoint before a value leaves the process. Tynn is a
            // zero-knowledge store; writing anything openable into it is a bug we
            // refuse to commit rather than report afterwards.
            if (!isPlausibleSealedBox(ciphertextB64)) {
                throw new Error(
                    `Refusing to write credential ${credentialId}: the payload is not a sealed-box ciphertext.`,
                );
            }
            await call(
                'PUT',
                `/provider-credentials/${encodeURIComponent(credentialId)}`,
                'write back credential',
                // Always escrow: a rotated value must stay openable by every
                // authorised host, including ones provisioned later.
                { ciphertext: ciphertextB64, sealedTo: 'escrow' },
            );
        },

        async listEscrowPending() {
            const raw = (await call('GET', '/escrow/pending', 'list escrow pending')) as {
                hosts?: unknown;
            };
            const rows = Array.isArray(raw?.hosts) ? raw.hosts : [];
            const pending: Array<{ workstationId: string; encryptionPublicKeyB64: string }> = [];
            for (const row of rows) {
                if (!row || typeof row !== 'object') continue;
                const r = row as Record<string, unknown>;
                const workstationId = str(r.workstationId);
                const encryptionPublicKeyB64 = str(r.encryptionPublicKey);
                // No published key ⇒ nothing to seal to. Skip rather than guess.
                if (!workstationId || !encryptionPublicKeyB64) continue;
                pending.push({ workstationId, encryptionPublicKeyB64 });
            }
            return pending;
        },

        async wrapEscrowForHost({ targetWorkstationId, ciphertext }) {
            await call('POST', '/escrow/wrapped-keys', 'wrap escrow for host', {
                targetWorkstationId,
                ciphertext,
            });
        },
    };
}

/**
 * Is this a `provider-credential.changed` push for OUR workstation channel? It
 * rides the SAME private `workstation.{id}` channel as `issuewatch.delta` and
 * `WorkspaceAssigned` — one socket, no new transport, no polling.
 */
export function isProviderCredentialChange(frame: PusherFrame, channel: string): boolean {
    return frame.event === 'provider-credential.changed' && frame.channel === channel;
}

const ACTIONS = new Set(['set', 'rotated', 'revoked']);

/**
 * Coerce an untrusted change payload. Null when it names no valid action or no
 * credential — a malformed push must do NOTHING rather than guess, since
 * guessing wrong could either revoke a live credential or leave a revoked one in
 * place.
 */
export function toProviderCredentialChange(raw: unknown): ProviderCredentialChange | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const action = str(r.action);
    const credentialId = str(r.credentialId);
    if (!action || !ACTIONS.has(action) || !credentialId) return null;
    return {
        action: action as ProviderCredentialChange['action'],
        credentialId,
        provider: str(r.provider) ?? undefined,
        kind: str(r.kind) ?? undefined,
        scope: str(r.scope) ?? undefined,
        projectId: str(r.projectId),
    };
}
