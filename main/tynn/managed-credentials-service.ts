import {
    ensureHostEncryptionKey,
    readHostEncryptionKeypair,
    type EnsureHostEncryptionKeyDeps,
} from '../host-core/crypto/host-encryption-key';
import {
    applyCredentialChange,
    bootstrapEscrowForPeers,
    managedEscrowPublicKey,
    managedSubscriptionCredentialId,
    refreshManagedCredentials,
    type CredentialChangeResult,
    type ManagedCredentialDeps,
    type ProviderCredentialChange,
    type RefreshSummary,
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
    /**
     * Apply a pushed `provider-credential.changed`. A `revoked` takes effect
     * immediately; a `set`/`rotated` triggers a re-fetch, so a credential the
     * owner ADDS reaches a running host without a restart.
     */
    onCredentialChange(event: ProviderCredentialChange): CredentialChangeResult;
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
        // Thunks, not values: a later refresh (or a re-key) moves the escrow key
        // AND can change which credential backs the file, while a watcher started
        // here lives for the whole process.
        escrowPublicKey: managedEscrowPublicKey,
        credentialId: managedSubscriptionCredentialId,
    };

    const refresh = async (): Promise<RefreshSummary> => {
        const summary = await refreshManagedCredentials(client, hostKeypair, materialize);
        // IDs + flags only — never a value.
        log(
            `managed credentials: ${summary.status}` +
                (summary.credentialIds.length ? ` ok=${summary.credentialIds.join(',')}` : '') +
                (summary.failed.length ? ` failed=${summary.failed.join(',')}` : '') +
                (summary.conflicts.length
                    ? ` ambiguous=${summary.conflicts.map((c) => c.target).join(',')}`
                    : ''),
        );
        // The one state that is silent-but-wrong: the owner HAS provisioned
        // credentials and this host can open none of them. Say so explicitly and
        // name the remedy — otherwise the host just appears to have no
        // credentials, with nothing pointing at why. An unprovisioned host with
        // nothing to open stays quiet (awaitingEscrow is empty).
        if (summary.awaitingEscrow.length) {
            log(
                `${summary.awaitingEscrow.length} credential(s) awaiting this host's escrow key ` +
                    `(${summary.awaitingEscrow.join(',')}) — a live peer will wrap it automatically, ` +
                    `or restore it from the owner's backup if no other host is running.`,
            );
        }
        return summary;
    };

    await refresh();

    // 2) Peer bootstrap: if this host holds the escrow key, vouch for any owner
    //    host that has published a pubkey but holds no copy yet. Best-effort.
    try {
        const peers = await bootstrapEscrowForPeers(client);
        if (peers.wrapped.length) log(`escrow wrapped for: ${peers.wrapped.join(',')}`);
        else if (peers.status === 'unavailable') log('escrow peer bootstrap unreachable; will retry');
        // 'no-escrow-key' / 'not-applicable' are routine lifecycle states — the
        // usual case on a host the owner hasn't provisioned. Logging them as
        // problems would train the reader to ignore this line.
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
        onCredentialChange: (event) => {
            const result = applyCredentialChange(event, materialize);
            // A set/rotated push means the bundle moved on — pull it. Fire and
            // forget: the caller is a socket handler, not an async context.
            if (result.refetch) void refresh();
            return result;
        },
        syncRotation: () => syncClaudeCredentialRotation(client, rotationDeps),
        stop: () => watcher?.stop(),
    };
}
