import { describe, expect, it } from 'vitest';
import { resolveDevSites, persistDevSites, type DevSitesStore } from '../hosting-config';
import type { DevSites } from '../../dev-server/sites-config';

/**
 * Where a workspace's dev-site config LIVES.
 *
 * Owner direction: hosting config must be saved WITH the workspace, as part of
 * the `.agi` envelope schema (project.json `sites`), so it is git-versioned and
 * travels with the repo — not stranded in the desktop's genie.db. So for an
 * ENVELOPE workspace the envelope is the source of truth and genie.db is a
 * mirror; a NON-envelope workspace (a plain folder, no project.json) has nowhere
 * portable to keep it and stays genie.db-only. An existing genie.db map is
 * MIGRATED into the envelope the first time it is read.
 *
 * `resolveDevSites` / `persistDevSites` are pure over an injected store, so all
 * of this is provable without a real database or a real project.json on disk.
 */

const SITE = (name: string): DevSites[string] =>
    ({ name, genName: `${name}.gen`, repo: '', runMode: 'explicit', kind: 'http', enabled: true }) as DevSites[string];

function fakeStore(
    over: { path?: string | null; envelope?: boolean; envelopeSites?: DevSites | null; db?: DevSites } = {},
) {
    const state = {
        path: over.path === undefined ? '/ws' : over.path,
        envelope: over.envelope ?? false,
        envelopeSites: over.envelopeSites ?? null,
        db: over.db ?? ({} as DevSites),
    };
    const writes = { envelope: [] as DevSites[], db: [] as DevSites[] };
    const persisted: Array<{ path: string; sites: DevSites }> = [];
    const store: DevSitesStore = {
        workspacePath: () => state.path,
        isEnvelope: () => state.envelope,
        readEnvelopeSites: () => state.envelopeSites,
        writeEnvelopeSites: (_p, sites) => {
            state.envelopeSites = sites;
            writes.envelope.push(sites);
        },
        dbRead: () => state.db,
        dbWrite: (_id, sites) => {
            state.db = sites;
            writes.db.push(sites);
        },
        onEnvelopePersisted: (path, sites) => persisted.push({ path, sites }),
    };
    return { store, state, writes, persisted };
}

describe('resolveDevSites — the .agi envelope is the source of truth', () => {
    it('reads straight from genie.db for a non-envelope workspace (no project.json)', () => {
        const { store, writes } = fakeStore({ envelope: false, db: { a: SITE('a') } });
        expect(resolveDevSites(store, 'w')).toEqual({ a: SITE('a') });
        expect(writes.envelope).toHaveLength(0); // never touches an envelope
    });

    it('returns the ENVELOPE sites and mirrors them to genie.db', () => {
        const env = { a: SITE('a') };
        const { store, writes } = fakeStore({ envelope: true, envelopeSites: env, db: {} });
        expect(resolveDevSites(store, 'w')).toEqual(env);
        expect(writes.db).toContainEqual(env); // mirror kept in step with the truth
    });

    it('MIGRATES an existing genie.db map into an envelope with no sites key yet', () => {
        const db = { a: SITE('a') };
        const { store, writes } = fakeStore({ envelope: true, envelopeSites: null, db });
        expect(resolveDevSites(store, 'w')).toEqual(db);
        expect(writes.envelope).toContainEqual(db); // seeded into project.json once
    });

    it('does NOT write an empty sites key into an envelope that has none (no spurious git diff)', () => {
        const { store, writes } = fakeStore({ envelope: true, envelopeSites: null, db: {} });
        expect(resolveDevSites(store, 'w')).toEqual({});
        expect(writes.envelope).toHaveLength(0);
    });
});

describe('persistDevSites — writes the truth, keeps the mirror', () => {
    it('writes only genie.db for a non-envelope workspace', () => {
        const { store, writes } = fakeStore({ envelope: false });
        persistDevSites(store, 'w', { a: SITE('a') });
        expect(writes.db).toContainEqual({ a: SITE('a') });
        expect(writes.envelope).toHaveLength(0);
    });

    it('writes the project.json AND mirrors genie.db for an envelope workspace', () => {
        const { store, writes } = fakeStore({ envelope: true });
        persistDevSites(store, 'w', { a: SITE('a') });
        expect(writes.envelope).toContainEqual({ a: SITE('a') });
        expect(writes.db).toContainEqual({ a: SITE('a') });
    });

    it('fires onEnvelopePersisted with (path, sites) after an envelope write — the Tynn-push seam', () => {
        const { store, persisted } = fakeStore({ envelope: true, path: '/ws' });
        persistDevSites(store, 'w', { a: SITE('a') });
        expect(persisted).toEqual([{ path: '/ws', sites: { a: SITE('a') } }]);
    });

    it('does NOT fire onEnvelopePersisted for a non-envelope workspace (nothing to sync)', () => {
        const { store, persisted } = fakeStore({ envelope: false });
        persistDevSites(store, 'w', { a: SITE('a') });
        expect(persisted).toHaveLength(0);
    });
});

describe('an EPHEMERAL workspace never touches the folder it sits on', () => {
    /**
     * A GApp PREVIEW registers a throwaway workspace whose path is the
     * DEVELOPER'S OWN SOURCE FOLDER — which is very often a `.gapp` envelope with
     * a tracked project.json. Nothing else in Genie has that shape: every other
     * workspace either owns its folder or is a plain directory.
     *
     * The envelope rule exists so hosting config travels with the repo. A
     * preview's site config must NOT travel with the repo: it is Genie's
     * scaffolding for a window that will be gone in a minute, at an address
     * (`<slug>.preview.gen`) the app does not serve at. Writing it would put a
     * spurious diff in the developer's tracked config, and it would outlive the
     * preview — which is the one thing a preview promises never to do.
     */
    it('persists to genie.db only, even on an envelope', () => {
        const { store, writes, persisted } = fakeStore({ envelope: true });
        const ephemeral: DevSitesStore = { ...store, isEphemeral: () => true };

        persistDevSites(ephemeral, 'w', { a: SITE('a') });

        expect(writes.db).toHaveLength(1);
        expect(writes.envelope).toHaveLength(0);
        // Nothing is mirrored onward either — there is nothing here Tynn should
        // learn about a window that is about to close.
        expect(persisted).toHaveLength(0);
    });

    it('reads its OWN sites, not the ones the folder happens to carry', () => {
        // The half that would be missed by only guarding the write: with the
        // envelope authoritative on READ, a preview's site would be written to
        // genie.db and then never seen again — the site would not start, and the
        // reason would be nowhere.
        const { store } = fakeStore({
            envelope: true,
            envelopeSites: { theirs: SITE('theirs') },
            db: { mine: SITE('mine') },
        });
        const ephemeral: DevSitesStore = { ...store, isEphemeral: () => true };

        expect(resolveDevSites(ephemeral, 'w')).toEqual({ mine: SITE('mine') });
    });

    it('never seeds the envelope from an ephemeral workspace’s db map', () => {
        // The migration path is the sneaky one: an envelope with no `sites` key
        // gets seeded from genie.db on first read. For a preview that would write
        // the preview's own site into the developer's project.json, on a plain
        // read, with nobody having asked for anything.
        const { store, writes } = fakeStore({
            envelope: true,
            envelopeSites: null,
            db: { mine: SITE('mine') },
        });
        const ephemeral: DevSitesStore = { ...store, isEphemeral: () => true };

        resolveDevSites(ephemeral, 'w');

        expect(writes.envelope).toHaveLength(0);
    });

    it('leaves an ordinary workspace on the envelope rule', () => {
        const { store, writes } = fakeStore({ envelope: true });
        const ordinary: DevSitesStore = { ...store, isEphemeral: () => false };

        persistDevSites(ordinary, 'w', { a: SITE('a') });

        expect(writes.envelope).toHaveLength(1);
    });
});
