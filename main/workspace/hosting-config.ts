import type { DevSites } from '../dev-server/sites-config';

/**
 * Where a workspace's dev-site config LIVES — with the `.agi` ENVELOPE as the
 * source of truth.
 *
 * Hosting config is saved WITH the workspace, as part of the envelope schema
 * (project.json `sites`), so it is git-versioned and travels with the repo
 * instead of being stranded in the desktop's genie.db. So for an ENVELOPE
 * workspace the envelope is authoritative and genie.db is a mirror (kept warm for
 * fast reads); a NON-envelope workspace — a plain folder with no project.json —
 * has nowhere portable to keep it and stays genie.db-only. An existing genie.db
 * map is MIGRATED into the envelope the first time it is read, so a workspace
 * that predates this never has to redefine its sites.
 *
 * The policy is pure over an injected {@link DevSitesStore}, so it is provable
 * without a real database or a real project.json — db.ts wires the live store.
 */
export interface DevSitesStore {
    /** The workspace's on-disk path, or null if it is unknown. */
    workspacePath(id: string): string | null;
    /** Is this path an `.agi` envelope (a usable project.json)? */
    isEnvelope(path: string): boolean;
    /** The envelope's stored sites, or null when project.json carries no `sites`
     *  key at all — distinct from an explicit empty map. */
    readEnvelopeSites(path: string): DevSites | null;
    /** Write the whole sites map into the envelope's project.json. */
    writeEnvelopeSites(path: string, sites: DevSites): void;
    /** The genie.db mirror. */
    dbRead(id: string): DevSites;
    dbWrite(id: string, sites: DevSites): void;
}

/** The workspace's dev sites, resolving the `.agi` envelope as source of truth. */
export function resolveDevSites(store: DevSitesStore, id: string): DevSites {
    const path = store.workspacePath(id);
    if (!path || !store.isEnvelope(path)) return store.dbRead(id);

    const envelope = store.readEnvelopeSites(path);
    if (envelope !== null) {
        store.dbWrite(id, envelope); // keep the mirror in step with the truth
        return envelope;
    }

    // The envelope has no `sites` key yet. Seed it from the genie.db map ONCE, so
    // a pre-existing workspace's sites become portable without the user
    // redefining them — but only when there is something to migrate, so a
    // workspace that never hosted anything gets no spurious project.json diff.
    const seeded = store.dbRead(id);
    if (Object.keys(seeded).length > 0) store.writeEnvelopeSites(path, seeded);
    return seeded;
}

/** Persist the whole dev-site map: the envelope is the truth, genie.db a mirror. */
export function persistDevSites(store: DevSitesStore, id: string, sites: DevSites): void {
    store.dbWrite(id, sites); // mirror always — fast reads + non-envelope workspaces
    const path = store.workspacePath(id);
    if (path && store.isEnvelope(path)) store.writeEnvelopeSites(path, sites);
}
