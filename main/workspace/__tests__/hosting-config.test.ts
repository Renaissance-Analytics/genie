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
