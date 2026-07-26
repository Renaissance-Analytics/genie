import {
    CLAUDE_SUBSCRIPTION,
    GITHUB_TOKEN,
    openCredentialBundle,
    openEscrowKeypair,
    wrapEscrowForPeer,
    type CredentialBundle,
} from './escrow';
import {
    applyGithubToken,
    credentialEnv,
    envVarForProvider,
    materializeClaudeCredentials,
    wipeClaudeCredentials,
    type ApplyResult,
    type CommandRunner,
    type MaterializeDeps,
} from './credential-materializer';
import type { EncryptionKeypair } from './sealed-box';

/**
 * The host-side orchestrator for Tynn-managed agent credentials: fetch the
 * owner's ciphertext bundle, open it through the escrow key, materialize each
 * credential where its CLI expects it, and hold the resulting environment so
 * every agent terminal spawned afterwards inherits it.
 *
 * **All state here is in memory only, for the life of the process.** Opened
 * plaintext is never persisted (the one exception is the Claude credential file,
 * which only exists because the Claude CLI has no other interface — 0600 in the
 * protected home). Nothing in this module logs a value, and every summary it
 * returns carries provider NAMES and booleans only, so a caller that logs a
 * summary — or an agent that reads one over MCP — still learns nothing.
 *
 * Revocation is push-driven, not polled: Tynn pushes a revoke over the existing
 * private `workstation.{id}` channel and {@link applyCredentialRevoke} wipes the
 * materialized file immediately and drops the value from the environment handed
 * to the next spawn. Already-running processes keep the copy they inherited —
 * that is inherent to process environments, and the reason a revoke also removes
 * the on-disk file, which IS shared with future reads.
 */

/** The Tynn calls this module makes — injected so it stays free of the
 *  electron-bound backend and tests pass a fake. */
export interface ManagedCredentialClient {
    /** This host's ciphertext bundle: the escrow key wrapped to this host + every
     *  credential sealed to the escrow public key. */
    fetchBundle(): Promise<CredentialBundle>;
    /** Rotation write-back — the new ciphertext, sealed to the ESCROW key. */
    putCredential(provider: string, ciphertextB64: string): Promise<void>;
    /** Owner hosts that published an encryption key but hold no escrow copy yet. */
    listEscrowPending(): Promise<Array<{ workstationId: string; encryptionPublicKeyB64: string }>>;
    /** Post an escrow private key wrapped for one of those hosts. */
    wrapEscrowForHost(input: {
        targetWorkstationId: string;
        wrappedPrivateKeyB64: string;
    }): Promise<void>;
}

/** Materialization seams (fs + the gh spawner), all injectable for tests. */
export interface ManagedCredentialDeps extends MaterializeDeps {
    runner?: CommandRunner;
}

export type RefreshStatus = 'ok' | 'no-escrow-key' | 'unavailable';

/** A REDACTED result — names and flags only, never a credential value. */
export interface RefreshSummary {
    status: RefreshStatus;
    /** Providers successfully opened AND materialized. */
    providers: string[];
    /** Providers whose ciphertext did not open — names only. */
    failed: string[];
    /** Env var NAMES now injected into agent terminals (not their values). */
    envVars: string[];
    claude: ApplyResult | null;
    github: ApplyResult | null;
}

interface ManagedState {
    /** provider → plaintext, for the env-injected providers ONLY. Keyed by
     *  provider (not env var) so a revoke naming a provider is a plain delete. */
    envValues: Record<string, string>;
    /** Retained so a rotation write-back seals to the key it opened with. */
    escrowPublicKeyB64: string | null;
    /** Retained so this host can vouch for a re-provisioned peer. */
    escrowKeypair: EncryptionKeypair | null;
    /** Whether a Claude credential file is currently materialized by us. */
    claudeMaterialized: boolean;
}

const emptyState = (): ManagedState => ({
    envValues: {},
    escrowPublicKeyB64: null,
    escrowKeypair: null,
    claudeMaterialized: false,
});

let state: ManagedState = emptyState();

/**
 * The env fragment for a new agent terminal. Read SYNCHRONOUSLY at spawn time so
 * the terminal layer needs no async plumbing. Built fresh each call — a caller
 * mutating its terminal env must not mutate the managed state.
 */
export function managedCredentialEnv(): Record<string, string> {
    return credentialEnv(state.envValues);
}

/** The escrow public key currently in force, or null when nothing is open. The
 *  rotation write-back seals to THIS key. */
export function managedEscrowPublicKey(): string | null {
    return state.escrowPublicKeyB64;
}

/** The escrow keypair this host holds, or null. Internal to the credential path
 *  (peer bootstrap + rotation); never expose it over IPC/MCP. */
export function managedEscrowKeypair(): EncryptionKeypair | null {
    return state.escrowKeypair;
}

/** Drop every in-memory credential without touching disk. Used on sign-out and
 *  by tests; a REVOKE should call {@link applyCredentialRevoke} instead so the
 *  materialized file goes too. */
export function resetManagedCredentials(): void {
    state = emptyState();
}

/**
 * Fetch → open → materialize. Called at host start and whenever Tynn pushes a
 * credential change.
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
        return { status: 'unavailable', providers: [], failed: [], envVars: [], claude: null, github: null };
    }

    const opened = await openCredentialBundle(bundle, hostKeypair);
    if (opened.status === 'no-escrow-key') {
        // We cannot open anything; leave whatever is already injected alone (this
        // is the bootstrap-pending case, not a revoke).
        return {
            status: 'no-escrow-key',
            providers: [],
            failed: opened.failed,
            envVars: Object.keys(managedCredentialEnv()),
            claude: null,
            github: null,
        };
    }

    const providers: string[] = [];
    const envValues: Record<string, string> = {};
    for (const [provider, value] of Object.entries(opened.values)) {
        if (!envVarForProvider(provider)) continue;
        envValues[provider] = value;
        providers.push(provider);
    }

    let claude: ApplyResult | null = null;
    const claudeBlob = opened.values[CLAUDE_SUBSCRIPTION];
    if (claudeBlob) {
        const written = materializeClaudeCredentials(claudeBlob, deps);
        claude = written.ok ? { ok: true } : { ok: false, reason: written.reason };
        if (written.ok) providers.push(CLAUDE_SUBSCRIPTION);
    }

    let github: ApplyResult | null = null;
    const githubToken = opened.values[GITHUB_TOKEN];
    if (githubToken) {
        github = await applyGithubToken(githubToken, { runner: deps.runner });
        if (github.ok) providers.push(GITHUB_TOKEN);
    }

    state = {
        envValues,
        escrowPublicKeyB64: opened.escrowPublicKeyB64,
        escrowKeypair: await openEscrowKeypair(bundle.escrow, hostKeypair),
        claudeMaterialized: claude?.ok === true,
    };

    return {
        status: 'ok',
        providers,
        failed: opened.failed,
        envVars: Object.keys(managedCredentialEnv()),
        claude,
        github,
    };
}

/** The revoke Tynn pushes: one provider, or the whole integration. */
export type CredentialRevoke = { provider: string; all?: false } | { all: true; provider?: undefined };

export interface RevokeResult {
    /** Provider names actually removed. */
    revoked: string[];
}

/**
 * Apply a revoke IMMEDIATELY: wipe the materialized Claude file and drop the
 * value from the env handed to the next spawn. An all-revoke additionally drops
 * the escrow key, so this host can neither open a future bundle nor vouch for a
 * peer until the owner re-authorises it.
 */
export function applyCredentialRevoke(
    event: CredentialRevoke,
    deps: ManagedCredentialDeps = {},
): RevokeResult {
    const revoked: string[] = [];

    if (event.all) {
        // Always attempt the wipe, even if we don't believe we materialized the
        // file — a previous process on this host may have, and a revoke must
        // leave nothing behind either way.
        wipeClaudeCredentials(deps);
        if (state.claudeMaterialized) revoked.push(CLAUDE_SUBSCRIPTION);
        revoked.push(...Object.keys(state.envValues));
        state = emptyState();
        return { revoked };
    }

    if (event.provider === CLAUDE_SUBSCRIPTION) {
        wipeClaudeCredentials(deps);
        if (state.claudeMaterialized) revoked.push(CLAUDE_SUBSCRIPTION);
        state = { ...state, claudeMaterialized: false };
        return { revoked };
    }

    if (state.envValues[event.provider] !== undefined) {
        const envValues = { ...state.envValues };
        delete envValues[event.provider];
        state = { ...state, envValues };
        revoked.push(event.provider);
    }
    return { revoked };
}

export interface PeerBootstrapSummary {
    status: 'ok' | 'no-escrow-key' | 'unavailable';
    /** Workstation ids this host wrapped the escrow key for. */
    wrapped: string[];
    /** Workstation ids skipped (malformed published key, or the post failed). */
    skipped: string[];
}

/**
 * New-host bootstrap, peer path (design brief option (a)): for every owner host
 * that has published an encryption public key but holds no escrow copy, seal the
 * escrow PRIVATE key to that host's public key and post the wrapped copy.
 *
 * Only ciphertext moves, and only a host that already holds the escrow key can
 * do it — so a host that cannot open anything cannot vouch for anyone. When no
 * host is alive, the owner's browser supplies the escrow key instead (W1).
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
            const wrappedPrivateKeyB64 = await wrapEscrowForPeer(
                escrowKeypair,
                peer.encryptionPublicKeyB64,
            );
            await client.wrapEscrowForHost({
                targetWorkstationId: peer.workstationId,
                wrappedPrivateKeyB64,
            });
            wrapped.push(peer.workstationId);
        } catch {
            // A malformed published key or a failed post — skip by NAME. Never
            // surface the error, which could quote key material.
            skipped.push(peer.workstationId);
        }
    }
    return { status: 'ok', wrapped, skipped };
}
