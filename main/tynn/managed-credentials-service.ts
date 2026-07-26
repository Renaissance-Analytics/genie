import {
    ensureHostEncryptionKey,
    readHostEncryptionKeypair,
    type EnsureHostEncryptionKeyDeps,
} from '../host-core/crypto/host-encryption-key';
import {
    applyCredentialRevoke,
    bootstrapEscrowForPeers,
    managedEscrowPublicKey,
    refreshManagedCredentials,
    type CredentialRevoke,
    type ManagedCredentialDeps,
    type RefreshSummary,
    type RevokeResult,
} from '../host-core/crypto/managed-credentials';
import {
    syncClaudeCredentialRotation,
    watchClaudeCredentialRotation,
    type RotationResult,
    type RotationWatcher,
    type WatchDeps,
} from '../host-core/crypto/claude-rotation';
import { createManagedCredentialClient, type HostSigner } from './managed-credential-client';
import { readWorkstationIdentity } from './workstation-identity';
import { tynnHost } from '../tynn-api';
import { getAllSettings } from '../db';

/** Read the `managed_credentials` gate, defaulting OFF — including when the DB
 *  isn't up yet, so a boot-order surprise can never turn the feature ON. */
function managedCredentialsEnabled(): boolean {
    try {
        return getAllSettings().managed_credentials === 'on';
    } catch {
        return false;
    }
}

/**
 * Boot wiring for Tynn-managed agent credentials — the one call the host shell
 * makes, desktop or headless.
 *
 * In order: ensure this host has an X25519 encryption keypair and Tynn knows its
 * public half → fetch + open this host's ciphertext bundle → materialize each
 * credential where its CLI reads it → vouch for any re-provisioned peer → start
 * the rotation watch.
 *
 * **Best-effort at every step.** A host that cannot reach Tynn, or whose owner
 * has provisioned nothing, must still boot with working terminals — it simply
 * gets no managed credentials. The one hard stop is unavailable OS encryption:
 * we refuse to hold a host private key we cannot store safely, so the whole
 * feature stays off rather than degrading (fail closed, see the brief).
 */

export interface StartManagedCredentialsDeps {
    /** Feature gate. Default: the `managed_credentials` setting, which defaults
     *  to OFF. Off means fully dark — no keypair is generated and no request is
     *  made, so a host whose owner has not opted in is byte-for-byte unchanged. */
    enabled?: boolean;
    /** The Ed25519 host proof. Default: the persisted local identity; null ⇒ this
     *  machine isn't an enrolled workstation and the feature stays off. */
    identity?: HostSigner | null;
    tynnApiBaseUrl?: string;
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
    /** Key persistence seams (default: the settings-backed encrypted store). */
    encryptionKey?: EnsureHostEncryptionKeyDeps;
    /** Materialization seams (fs + the gh spawner). */
    materialize?: ManagedCredentialDeps;
    /** Rotation watch seams (fs.watch factory, debounce). */
    rotation?: Pick<WatchDeps, 'watch' | 'debounceMs'>;
}

export interface ManagedCredentialsHandle {
    /** Re-fetch and re-materialize (on a push, or a manual re-sync). */
    refresh(): Promise<RefreshSummary>;
    /** Apply a pushed revoke immediately. */
    onRevoke(event: CredentialRevoke): RevokeResult;
    /** Force a rotation check (the watch does this on file change). */
    syncRotation(): Promise<RotationResult>;
    stop(): void;
}

export async function startManagedCredentials(
    deps: StartManagedCredentialsDeps = {},
): Promise<ManagedCredentialsHandle | null> {
    const log = deps.log ?? (() => {});
    if (!(deps.enabled ?? managedCredentialsEnabled())) return null;

    const identity = deps.identity !== undefined ? deps.identity : readWorkstationIdentity();
    if (!identity) return null;

    const client = createManagedCredentialClient(
        identity,
        deps.tynnApiBaseUrl ?? tynnHost(),
        deps.fetchImpl ?? fetch,
    );

    // 1) This host's encryption identity. A throw here means we could not store a
    //    private key safely — stay off entirely rather than run degraded.
    try {
        await ensureHostEncryptionKey(client, deps.encryptionKey);
    } catch (e) {
        log(`managed credentials off: ${String(e)}`);
        return null;
    }
    const hostKeypair = readHostEncryptionKeypair(deps.encryptionKey?.read);
    if (!hostKeypair) {
        log('managed credentials off: the host encryption key could not be read back.');
        return null;
    }

    const materialize = deps.materialize ?? {};
    const rotationDeps: WatchDeps = {
        ...materialize,
        ...deps.rotation,
        // A thunk, not a value: a later refresh (or a re-key) moves the escrow
        // key, and a watcher started here lives for the whole process.
        escrowPublicKey: managedEscrowPublicKey,
    };

    const refresh = async (): Promise<RefreshSummary> => {
        const summary = await refreshManagedCredentials(client, hostKeypair, materialize);
        // Names + flags only — never a value.
        log(
            `managed credentials: ${summary.status}` +
                (summary.providers.length ? ` providers=${summary.providers.join(',')}` : '') +
                (summary.failed.length ? ` failed=${summary.failed.join(',')}` : ''),
        );
        return summary;
    };

    await refresh();

    // 2) Peer bootstrap: if this host holds the escrow key, vouch for any owner
    //    host that has published a pubkey but holds no copy yet. Best-effort.
    try {
        const peers = await bootstrapEscrowForPeers(client);
        if (peers.wrapped.length) log(`escrow wrapped for: ${peers.wrapped.join(',')}`);
    } catch (e) {
        log(`escrow peer bootstrap skipped: ${String(e)}`);
    }

    // 3) Rotation watch — event-driven, no polling.
    let watcher: RotationWatcher | null = null;
    try {
        watcher = watchClaudeCredentialRotation(client, rotationDeps);
    } catch (e) {
        log(`rotation watch not started: ${String(e)}`);
    }

    return {
        refresh,
        onRevoke: (event) => applyCredentialRevoke(event, materialize),
        syncRotation: () => syncClaudeCredentialRotation(client, rotationDeps),
        stop: () => watcher?.stop(),
    };
}
