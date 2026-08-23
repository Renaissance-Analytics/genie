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
    /**
     * Fired AFTER the ENVELOPE's sites were written (envelope workspaces only) —
     * the seam a shell uses to mirror the config onward, e.g. push it to Tynn so
     * the hosting control UX can track it. Optional; must never throw into the
     * write path (the local write has already succeeded by the time it runs).
     */
    onEnvelopePersisted?(path: string, sites: DevSites): void;
    /**
     * Is this workspace EPHEMERAL — a throwaway registration on a folder that
     * belongs to somebody else?
     *
     * A GApp PREVIEW is the case, and it is the only shape in Genie where the
     * envelope rule points the wrong way. Its workspace sits on the DEVELOPER'S
     * OWN SOURCE FOLDER, which is very often a `.gapp` envelope with a tracked
     * project.json — but its site config is not the app's config. It is Genie's
     * scaffolding for a window that will be gone in a minute, at an address
     * (`<slug>.preview.gen`) the app does not serve at.
     *
     * "Travels with the repo" is exactly the wrong property for that: it would put
     * a spurious diff in the developer's tracked config and it would outlive the
     * preview, which is the one thing a preview promises never to do.
     *
     * Optional; absent reads as "no", so every existing store is unchanged.
     */
    isEphemeral?(id: string): boolean;
}

/** The workspace's dev sites, resolving the `.agi` envelope as source of truth. */
export function resolveDevSites(store: DevSitesStore, id: string): DevSites {
    const path = store.workspacePath(id);
    // Ephemeral first, and on the READ side too. Guarding only the write would
    // leave a preview's site written to genie.db and then never read back — the
    // site would not start and the reason would be nowhere. Worse, the migration
    // below would seed the developer's project.json from the preview's own map,
    // on a plain read, with nobody having asked for anything.
    if (!path || store.isEphemeral?.(id) || !store.isEnvelope(path)) return store.dbRead(id);

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
    if (path && !store.isEphemeral?.(id) && store.isEnvelope(path)) {
        store.writeEnvelopeSites(path, sites);
        store.onEnvelopePersisted?.(path, sites); // mirror onward (e.g. push to Tynn)
    }
}
