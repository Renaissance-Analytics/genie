import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';
import { sealForEscrow } from './escrow';
import { claudeCredentialsPath, type CredentialFs } from './credential-materializer';

/**
 * Claude subscription ROTATION write-back.
 *
 * The Claude CLI silently rotates the OAuth refresh token inside
 * `~/.claude/.credentials.json` while an agent works. If the host ignored that,
 * Tynn's stored copy would go stale and every host provisioned later — plus this
 * one after a wipe — would need a fresh human login.
 *
 * So the host detects the change and PUTs a new ciphertext. Two properties make
 * that safe:
 *
 * - it re-seals to the **ESCROW public key**, not to this host's own key, so the
 *   rotated value stays openable by every authorised host including future ones;
 * - it tracks only a **SHA-256 digest** of the blob it last wrote, never the blob
 *   itself, so change detection costs no additional plaintext in memory.
 *
 * Detection is **event-driven** (`fs.watch` on `~/.claude/`, debounced) — no
 * polling loop. The watch is on the DIRECTORY because editors and CLIs commonly
 * replace a credential file via write-temp-then-rename, which a watch on the
 * file's own inode would miss.
 */

/** The digest of the blob we last wrote or wrote back. NEVER the blob. */
let lastDigest: string | null = null;

function digest(blob: string): string {
    return createHash('sha256').update(blob, 'utf8').digest('hex');
}

/** Record the blob we just materialized as the rotation baseline, so the write
 *  we ourselves performed is not mistaken for a CLI rotation. */
export function noteClaudeCredentialBlob(blob: string): void {
    lastDigest = blob?.trim() ? digest(blob) : null;
}

/** Forget the baseline (sign-out, revoke, tests). */
export function resetClaudeRotation(): void {
    lastDigest = null;
}

/** The one Tynn call rotation makes. */
export interface RotationClient {
    putCredential(credentialId: string, ciphertextB64: string): Promise<void>;
}

export interface RotationDeps {
    homeDir?: string;
    fs?: CredentialFs;
    /**
     * The escrow public key to re-seal to. Absent/null ⇒ refuse to write back.
     *
     * Accepts a THUNK because the watcher outlives any single value: a refresh
     * (or a re-provision) can swap the host's escrow key underneath a watcher
     * that was started once at boot, and a captured string would keep sealing
     * rotations to a key the fleet has moved off. It is passed in rather than
     * read from `managed-credentials` so this module stays a leaf — the
     * orchestrator depends on rotation, not the other way around.
     */
    escrowPublicKey?: string | null | (() => string | null);
    /**
     * The Tynn credential id backing the materialized file — the write-back
     * target. A thunk for the same reason as the escrow key: a refresh can swap
     * which credential is materialized under a long-lived watcher. Absent/null ⇒
     * nothing is materialized by us, so there is nothing to write back to.
     *
     * Keyed on the ID rather than the provider because an account-wide and a
     * project-scoped subscription can coexist; a provider-keyed PUT would
     * overwrite whichever the server guessed.
     */
    credentialId?: string | null | (() => string | null);
}

const defaultFs: CredentialFs = {
    mkdirSync: (dir, opts) => void nodeFs.mkdirSync(dir, opts),
    writeFileSync: (file, data, opts) => nodeFs.writeFileSync(file, data, opts),
    chmodSync: (file, mode) => nodeFs.chmodSync(file, mode),
    existsSync: (file) => nodeFs.existsSync(file),
    rmSync: (file, opts) => nodeFs.rmSync(file, opts),
    readFileSync: (file) => nodeFs.readFileSync(file, 'utf8'),
};

export type RotationStatus =
    /** A change was detected, re-sealed to escrow, and PUT. */
    | 'written'
    /** No baseline existed; the on-disk blob was adopted as the baseline. */
    | 'adopted'
    /** The file matches the baseline. */
    | 'unchanged'
    /** No credential file (never set, or revoked). */
    | 'absent'
    /** Nothing to seal to — the host holds no escrow key. */
    | 'no-escrow-key'
    /** No credential id to write back to — nothing was materialized by us. */
    | 'no-credential-id'
    /** Seal or PUT failed; the baseline is unchanged so the next tick retries. */
    | 'error';

export interface RotationResult {
    status: RotationStatus;
}

function resolveLate(value: string | null | undefined | (() => string | null)): string | null {
    return (typeof value === 'function' ? value() : value) ?? null;
}

/**
 * Read the credential file and, if it differs from the baseline, re-seal it to
 * the escrow key and PUT the ciphertext.
 *
 * With no baseline the on-disk blob is **adopted silently** rather than written
 * back: at that point Tynn's copy is the very thing that produced the file, so a
 * PUT would be a pointless round trip that also re-seals a value we have no
 * evidence changed.
 *
 * On failure the baseline is deliberately NOT advanced, so the next change event
 * retries the same rotation instead of losing it.
 */
export async function syncClaudeCredentialRotation(
    client: RotationClient,
    deps: RotationDeps = {},
): Promise<RotationResult> {
    const fsImpl = deps.fs ?? defaultFs;
    const file = claudeCredentialsPath(deps.homeDir);

    let blob: string;
    try {
        if (!fsImpl.existsSync(file)) return { status: 'absent' };
        blob = fsImpl.readFileSync(file);
    } catch {
        return { status: 'absent' };
    }
    if (!blob?.trim()) return { status: 'absent' };

    const current = digest(blob);
    if (lastDigest === null) {
        lastDigest = current;
        return { status: 'adopted' };
    }
    if (current === lastDigest) return { status: 'unchanged' };

    const escrowPublicKeyB64 = resolveLate(deps.escrowPublicKey);
    if (!escrowPublicKeyB64) return { status: 'no-escrow-key' };
    const credentialId = resolveLate(deps.credentialId);
    if (!credentialId) return { status: 'no-credential-id' };

    try {
        const ciphertext = await sealForEscrow(blob, escrowPublicKeyB64);
        await client.putCredential(credentialId, ciphertext);
    } catch {
        // Baseline intentionally NOT advanced — retry on the next change.
        return { status: 'error' };
    }
    lastDigest = current;
    return { status: 'written' };
}

/** The `fs.watch` seam — injected so tests drive change events with no real IO. */
export type WatchFactory = (dir: string, onChange: () => void) => { close(): void };

export interface WatchDeps extends RotationDeps {
    /** Coalescing window for a burst of change events. Default 250ms. */
    debounceMs?: number;
    watch?: WatchFactory;
}

export interface RotationWatcher {
    stop(): void;
}

const defaultWatch: WatchFactory = (dir, onChange) => {
    const watcher = nodeFs.watch(dir, { persistent: false }, () => onChange());
    return { close: () => watcher.close() };
};

/**
 * Watch `~/.claude/` and write back a rotated credential. Event-driven and
 * debounced: a CLI rewriting the file emits several events, and we want one PUT.
 *
 * A watch that cannot be established (no `~/.claude/` yet) is not an error — the
 * directory appears when the first credential is materialized, and the caller
 * re-establishes the watch then.
 */
export function watchClaudeCredentialRotation(
    client: RotationClient,
    deps: WatchDeps = {},
): RotationWatcher {
    const dir = path.dirname(claudeCredentialsPath(deps.homeDir));
    const debounceMs = deps.debounceMs ?? 250;
    let timer: NodeJS.Timeout | null = null;
    let handle: { close(): void } | null = null;

    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void syncClaudeCredentialRotation(client, deps);
        }, debounceMs);
        timer.unref?.();
    };

    try {
        handle = (deps.watch ?? defaultWatch)(dir, schedule);
    } catch {
        handle = null;
    }

    return {
        stop() {
            if (timer) clearTimeout(timer);
            timer = null;
            try {
                handle?.close();
            } catch {
                /* already closed */
            }
        },
    };
}
