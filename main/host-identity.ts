import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Stable, per-INSTALL host identity for Work Mode / mobile remote control.
 *
 * A Genie host used to be identified ONLY by its mutable Tailscale IP: the mobile
 * server binds the 100.x address, and the remote's connKey / token store /
 * known-hosts were all keyed by `ip:port`. Tailscale reassigns a node's 100.x on
 * logout / re-auth / re-key, and can recycle a freed address to another node, so
 * an IP-keyed pairing silently ORPHANED (forced back to PIN — "it stopped
 * working") or a stale token hit the WRONG host (401 → clearSavedToken). The
 * relay/Virtual-Workstation path never had this — it keys on a stable
 * `ws:<workstationId>`. This module supplies the tailnet analogue: a
 * carrier-independent `hostId` that never changes.
 *
 * `hostId` is a UUID minted ONCE and persisted in `<userData>/genie-host-id.json`,
 * stable across restarts AND IP changes. It is advertised on `/api/ping` and is
 * the PRIMARY identity for connKey / token / known-host; the Tailscale IP (and the
 * MagicDNS name) are demoted to a refreshable DIAL ADDRESS. It is carrier-
 * independent by design so the same identity works over relay / Aionima later.
 */

/** The persisted-id filename under `userData`. */
const FILE = 'genie-host-id.json';

/** In-process cache so repeated reads (every `/api/ping`) don't hit the disk. */
let cached: string | null = null;

function idPath(userDataDir: string): string {
    return path.join(userDataDir, FILE);
}

/**
 * The stable install id for THIS host, read from disk (minting + persisting one on
 * first use). Cached for the process. Best-effort persistence: if the write fails
 * we still return a stable in-memory id for this run, so identity is never blank —
 * it just wouldn't survive a restart in that (rare) case.
 *
 * There is no pre-existing machine/install id anywhere in Genie's userData to
 * reuse (searched: no `machineId` / `installId` / device-uuid store), so we mint a
 * dedicated one rather than piggy-backing on a value owned by another concern.
 */
export function hostInstallId(userDataDir: string): string {
    if (cached) return cached;
    const p = idPath(userDataDir);
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { hostId?: unknown };
        if (typeof raw.hostId === 'string' && raw.hostId.length > 0) {
            cached = raw.hostId;
            return cached;
        }
    } catch {
        /* no / garbled file — mint a fresh id below */
    }
    const id = crypto.randomUUID();
    cached = id;
    try {
        // 0600: not secret, but there's no reason to make it world-readable.
        fs.writeFileSync(p, JSON.stringify({ hostId: id }) + '\n', { mode: 0o600 });
    } catch {
        /* best-effort — a non-persisted id is still stable for this run */
    }
    return id;
}

/** Test-only: clear the process cache so a test can point at a fresh userData dir. */
export function _resetHostIdForTest(): void {
    cached = null;
}
