import {
    ANTHROPIC,
    API_KEY,
    GITHUB,
    SUBSCRIPTION,
    openCredentialBundle,
    openEscrowKeypair,
    wrapEscrowForPeer,
    type CredentialBundle,
    type OpenedCredential,
} from './escrow';
import {
    applyGithubToken,
    credentialEnv,
    envVarForCredential,
    materializeClaudeCredentials,
    resolveHostGlobal,
    wipeClaudeCredentials,
    type ApplyResult,
    type CommandRunner,
    type CredentialFs,
    type MaterializeDeps,
} from './credential-materializer';
import { noteClaudeCredentialBlob, resetClaudeRotation } from './claude-rotation';
import type { EncryptionKeypair } from './sealed-box';

/**
 * The host-side orchestrator for Tynn-managed agent credentials: fetch the
 * owner's ciphertext bundle, open it through the escrow key, materialize each
 * credential where its CLI expects it, and hold the result so every agent
 * terminal spawned afterwards inherits it.
 *
 * **All state here is in memory only, for the life of the process.** Opened
 * plaintext is never persisted (the one exception is the Claude credential file,
 * which exists only because the Claude CLI has no other interface — 0600 in the
 * protected home). Nothing in this module logs a value, and every summary it
 * returns carries credential IDs and booleans only, so a caller that logs a
 * summary — or an agent that reads one over MCP — still learns nothing.
 *
 * Change is push-driven, not polled: Tynn pushes `provider-credential.changed`
 * over the existing private `workstation.{id}` channel with one of three
 * actions. `revoked` wipes immediately; `set`/`rotated` ask for a re-fetch — a
 * revoke-only event would leave a newly ADDED credential unseen until restart,
 * which is a poll in disguise.
 *
 * Already-running processes keep the env they inherited — inherent to process
 * environments, and the reason a revoke also removes the on-disk file, which IS
 * shared with future reads.
 */

/** The Tynn calls this module makes — injected so it stays free of the
 *  electron-bound backend and tests pass a fake. */
export interface ManagedCredentialClient {
    /** This host's ciphertext bundle: the escrow key wrapped to this host + every
     *  credential the owner has provisioned for it. */
    fetchBundle(): Promise<CredentialBundle>;
    /**
     * Rotation write-back, keyed on the CREDENTIAL ID — not the provider. An
     * account-wide and a project-scoped credential can share a provider, so a
     * provider-keyed write would overwrite whichever the server guessed.
     */
    putCredential(credentialId: string, ciphertextB64: string): Promise<void>;
    /** Owner hosts that published an encryption key but hold no escrow copy yet. */
    listEscrowPending(): Promise<Array<{ workstationId: string; encryptionPublicKeyB64: string }>>;
    /** Post an escrow private key wrapped for one of those hosts. */
    wrapEscrowForHost(input: { targetWorkstationId: string; ciphertext: string }): Promise<void>;
}

/**
 * Materialization seams (fs + the gh spawner), all injectable for tests.
 *
 * The fs here is the FULL {@link CredentialFs}, not the write-only
 * `MaterializerFs`: this module owns the whole flow and passes the same fs on to
 * rotation, which must read the file back. Demanding the read up front means a
 * caller cannot inject a write-only fs and silently lose rotation write-back.
 */
export interface ManagedCredentialDeps extends Omit<MaterializeDeps, 'fs'> {
    fs?: CredentialFs;
    runner?: CommandRunner;
}

export type RefreshStatus = 'ok' | 'no-escrow-key' | 'unavailable';

/** A host-global slot that could not be filled because project scope was
 *  ambiguous. IDs only — never values. */
export interface HostGlobalConflict {
    target: 'github' | 'claude_subscription';
    credentialIds: string[];
}

/** A REDACTED result — ids and flags only, never a credential value. */
export interface RefreshSummary {
    status: RefreshStatus;
    /** Credential IDs successfully opened AND materialized. */
    credentialIds: string[];
    /** Credential IDs whose ciphertext did not open. */
    failed: string[];
    /** Env var NAMES currently injectable (not their values). */
    envVars: string[];
    /** Single-slot targets left unfilled because several project-scoped
     *  credentials competed for them. */
    conflicts: HostGlobalConflict[];
    claude: ApplyResult | null;
    github: ApplyResult | null;
}

interface ManagedState {
    /** Every opened credential, in memory only. Keyed access is by id. */
    credentials: OpenedCredential[];
    /** Retained so a rotation write-back seals to the key it opened with. */
    escrowPublicKeyB64: string | null;
    /** Retained so this host can vouch for a re-provisioned peer. */
    escrowKeypair: EncryptionKeypair | null;
    /** The credential id currently materialized as ~/.claude/.credentials.json,
     *  so a revoke of some OTHER credential doesn't wipe it and a rotation
     *  write-back targets the right row. */
    subscriptionCredentialId: string | null;
}

const emptyState = (): ManagedState => ({
    credentials: [],
    escrowPublicKeyB64: null,
    escrowKeypair: null,
    subscriptionCredentialId: null,
});

let state: ManagedState = emptyState();

/**
 * The env fragment for a new agent terminal in the workspace whose Tynn project
 * is `projectId`. Read SYNCHRONOUSLY at spawn time so the terminal layer needs no
 * async plumbing, and resolved per call so a project override applies to exactly
 * the workspace it belongs to.
 */
export function managedCredentialEnv(projectId?: string | null): Record<string, string> {
    return credentialEnv(state.credentials, projectId);
}

/** The escrow public key currently in force, or null. Rotation seals to THIS. */
export function managedEscrowPublicKey(): string | null {
    return state.escrowPublicKeyB64;
}

/** The credential id backing the materialized Claude credential file, or null —
 *  the write-back target for a detected rotation. */
export function managedSubscriptionCredentialId(): string | null {
    return state.subscriptionCredentialId;
}

/** The escrow keypair this host holds, or null. Internal to the credential path
 *  (peer bootstrap); never expose it over IPC/MCP. */
export function managedEscrowKeypair(): EncryptionKeypair | null {
    return state.escrowKeypair;
}

/** Drop every in-memory credential without touching disk. Used on sign-out and
 *  by tests; a REVOKE should call {@link applyCredentialChange} so the
 *  materialized file goes too. */
export function resetManagedCredentials(): void {
    state = emptyState();
}

/**
 * Fetch → open → materialize. Called at host start, and again whenever Tynn
 * pushes a `set`/`rotated` change.
 *
 * On a fetch failure the PREVIOUS injection is deliberately left in place: a
 * transient Tynn outage must not silently un-authenticate every agent on the
 * host. Only an explicit revoke removes a credential.
 */
export async function refreshManagedCredentials(
    client: ManagedCredentialClient,
    hostKeypair: EncryptionKeypair,
    deps: ManagedCredentialDeps = {},
): Promise<RefreshSummary> {
    let bundle: CredentialBundle;
    try {
        bundle = await client.fetchBundle();
    } catch {
        return {
            status: 'unavailable',
            credentialIds: [],
            failed: [],
            envVars: [],
            conflicts: [],
            claude: null,
            github: null,
        };
    }

    const opened = await openCredentialBundle(bundle, hostKeypair);
    if (opened.status === 'no-escrow-key' && opened.credentials.length === 0) {
        // Nothing openable at all — the bootstrap-pending case. Leave whatever is
        // already injected alone; this is not a revoke.
        return {
            status: 'no-escrow-key',
            credentialIds: [],
            failed: opened.failed,
            envVars: Object.keys(managedCredentialEnv()),
            conflicts: [],
            claude: null,
            github: null,
        };
    }

    const credentialIds: string[] = [];
    const conflicts: HostGlobalConflict[] = [];
    for (const credential of opened.credentials) {
        if (envVarForCredential(credential)) credentialIds.push(credential.id);
    }

    // --- anthropic/subscription → the Claude CLI's credential file ------------
    let claude: ApplyResult | null = null;
    let subscriptionCredentialId: string | null = null;
    const subscription = resolveHostGlobal(opened.credentials, ANTHROPIC, SUBSCRIPTION);
    if (subscription.status === 'ambiguous') {
        conflicts.push({ target: 'claude_subscription', credentialIds: subscription.conflictIds! });
        claude = { ok: false, reason: 'Several project-scoped subscriptions compete for one host.' };
    } else if (subscription.credential) {
        const written = materializeClaudeCredentials(subscription.credential.value, deps);
        claude = written.ok ? { ok: true } : { ok: false, reason: written.reason };
        if (written.ok) {
            credentialIds.push(subscription.credential.id);
            subscriptionCredentialId = subscription.credential.id;
            // Our OWN write is the rotation baseline. Without this the watcher
            // would see the file appear, call it a rotation, and PUT the value
            // straight back to the store it just came from.
            noteClaudeCredentialBlob(subscription.credential.value);
        }
    }

    // --- github/api_key → gh auth login --------------------------------------
    let github: ApplyResult | null = null;
    const githubToken = resolveHostGlobal(opened.credentials, GITHUB, API_KEY);
    if (githubToken.status === 'ambiguous') {
        conflicts.push({ target: 'github', credentialIds: githubToken.conflictIds! });
        github = { ok: false, reason: 'Several project-scoped GitHub tokens compete for one host.' };
    } else if (githubToken.credential) {
        github = await applyGithubToken(githubToken.credential.value, { runner: deps.runner });
        if (github.ok) credentialIds.push(githubToken.credential.id);
    }

    state = {
        credentials: opened.credentials,
        escrowPublicKeyB64: opened.escrowPublicKeyB64,
        escrowKeypair: await openEscrowKeypair(bundle.escrow, hostKeypair),
        subscriptionCredentialId,
    };

    return {
        status: opened.status === 'ok' ? 'ok' : 'no-escrow-key',
        credentialIds,
        failed: opened.failed,
        envVars: Object.keys(managedCredentialEnv()),
        conflicts,
        claude,
        github,
    };
}

/** Tynn's `provider-credential.changed` push. One event covers all three
 *  transitions, so a newly ADDED credential reaches a running host too. */
export interface ProviderCredentialChange {
    action: 'set' | 'rotated' | 'revoked';
    credentialId: string;
    provider?: string;
    kind?: string;
    scope?: string;
    projectId?: string | null;
}

export interface CredentialChangeResult {
    /** Credential IDs actually removed. */
    revoked: string[];
    /** True when the caller should re-fetch the bundle (a set/rotated push). */
    refetch: boolean;
}

/**
 * Apply a pushed change IMMEDIATELY.
 *
 * `revoked` drops the credential from the env handed to the next spawn and, when
 * it is the one backing the Claude credential file, wipes that file at once. A
 * revoke of some OTHER credential must NOT touch the file — hence tracking which
 * id materialized it.
 *
 * `set`/`rotated` deliberately tear nothing down: they ask the caller to
 * re-fetch, so the host keeps working through the round trip rather than
 * blinking its credentials off and on.
 */
export function applyCredentialChange(
    event: ProviderCredentialChange,
    deps: ManagedCredentialDeps = {},
): CredentialChangeResult {
    if (event.action !== 'revoked') return { revoked: [], refetch: true };

    const revoked: string[] = [];
    const remaining = state.credentials.filter((c) => c.id !== event.credentialId);
    if (remaining.length !== state.credentials.length) revoked.push(event.credentialId);

    let subscriptionCredentialId = state.subscriptionCredentialId;
    if (subscriptionCredentialId === event.credentialId) {
        wipeClaudeCredentials(deps);
        resetClaudeRotation();
        subscriptionCredentialId = null;
    }

    state = { ...state, credentials: remaining, subscriptionCredentialId };
    return { revoked, refetch: false };
}

export interface PeerBootstrapSummary {
    status: 'ok' | 'no-escrow-key' | 'unavailable';
    /** Workstation ids this host wrapped the escrow key for. */
    wrapped: string[];
    /** Workstation ids skipped (malformed published key, or the post failed). */
    skipped: string[];
}

/**
 * New-host bootstrap, peer path: for every owner host that has published an
 * encryption public key but holds no escrow copy, seal the escrow PRIVATE key to
 * that host's public key and post the wrapped copy.
 *
 * Returns early — WITHOUT calling Tynn — when this host holds no escrow key.
 * Tynn 403s that caller by design (a host that can open nothing cannot vouch for
 * anyone), so asking would be a guaranteed error, not a check.
 */
export async function bootstrapEscrowForPeers(
    client: ManagedCredentialClient,
): Promise<PeerBootstrapSummary> {
    const escrowKeypair = state.escrowKeypair;
    if (!escrowKeypair) return { status: 'no-escrow-key', wrapped: [], skipped: [] };

    let pending: Array<{ workstationId: string; encryptionPublicKeyB64: string }>;
    try {
        pending = await client.listEscrowPending();
    } catch {
        return { status: 'unavailable', wrapped: [], skipped: [] };
    }

    const wrapped: string[] = [];
    const skipped: string[] = [];
    for (const peer of pending) {
        try {
            const ciphertext = await wrapEscrowForPeer(escrowKeypair, peer.encryptionPublicKeyB64);
            await client.wrapEscrowForHost({ targetWorkstationId: peer.workstationId, ciphertext });
            wrapped.push(peer.workstationId);
        } catch {
            // A malformed published key or a failed post — skip by NAME. Never
            // surface the error, which could quote key material.
            skipped.push(peer.workstationId);
        }
    }
    return { status: 'ok', wrapped, skipped };
}
