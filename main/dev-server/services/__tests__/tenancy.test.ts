import { describe, expect, it } from 'vitest';
import { purgeVerdict, sliceTenantsOf } from '../tenancy';
import { workspaceSqlIdentifier } from '../catalog';
import type { DevServices } from '../services-config';

/**
 * WHO HAS DATA IN THIS VOLUME (Tynn #250, step 4).
 *
 * The shared model puts every workspace's database in ONE named volume per
 * (engine, major). The guard in front of `remove --purge` used to ask who was
 * HOLDING the engine — a live connection count — which is not the same question
 * and answered `nobody` for exactly the workspaces that most needed protecting:
 * a Genie App with its window closed, a project nobody has opened today.
 *
 * These tests pin the difference, and pin the refusal itself — because a
 * refusal that does not say what it saved is the thing someone adds a `force`
 * flag to six months later.
 */

const PG16 = {
    engine: 'postgres' as const,
    version: '16',
    dedicated: false,
    password: 'workspace_pw_0123456789',
    enabled: true,
};

const ws = (id: string, over: { label?: string; appKind?: 'app' | 'app-dev' } = {}) => ({
    id,
    path: `/work/${id}`,
    label: over.label ?? id,
    ...(over.appKind ? { appKind: over.appKind } : {}),
});

const query = (
    services: Record<string, DevServices>,
    over: {
        recordKey?: string;
        asking?: string;
        workspaces?: ReturnType<typeof ws>[];
        servicesFor?: (id: string) => DevServices;
    } = {},
) => ({
    recordKey: over.recordKey ?? 'postgres-16',
    askingWorkspaceId: over.asking ?? 'a',
    workspaces: over.workspaces ?? Object.keys(services).map((id) => ws(id)),
    servicesFor: over.servicesFor ?? ((id: string) => services[id] ?? {}),
});

describe('sliceTenantsOf', () => {
    it('finds a workspace that is not running — the whole point', () => {
        const { tenants } = sliceTenantsOf(
            query({ a: { 'svc-a': { ...PG16 } }, b: { 'svc-b': { ...PG16 } } }),
        );
        expect(tenants.map((t) => t.workspaceId)).toEqual(['b']);
        expect(tenants[0]?.identifier).toBe(workspaceSqlIdentifier('b'));
    });

    it('never counts the workspace doing the asking', () => {
        const { tenants } = sliceTenantsOf(query({ a: { 'svc-a': { ...PG16 } } }));
        expect(tenants).toEqual([]);
    });

    it('counts a DISABLED service — the database it made is still in there', () => {
        const { tenants } = sliceTenantsOf(
            query({
                a: { 'svc-a': { ...PG16 } },
                b: { 'svc-b': { ...PG16, enabled: false } },
            }),
        );
        expect(tenants.map((t) => t.workspaceId)).toEqual(['b']);
    });

    it('ignores a workspace on a DIFFERENT major — a different container, a different volume', () => {
        const { tenants } = sliceTenantsOf(
            query({
                a: { 'svc-a': { ...PG16 } },
                b: { 'svc-b': { ...PG16, version: '17' } },
            }),
        );
        expect(tenants).toEqual([]);
    });

    it('ignores a workspace with its OWN dedicated container', () => {
        const { tenants } = sliceTenantsOf(
            query({
                a: { 'svc-a': { ...PG16 } },
                b: { 'svc-b': { ...PG16, dedicated: true } },
            }),
        );
        expect(tenants).toEqual([]);
    });

    it('reports a workspace whose services could not be read, rather than skipping it', () => {
        const services = { a: { 'svc-a': { ...PG16 } }, b: { 'svc-b': { ...PG16 } } };
        const { tenants, unreadable } = sliceTenantsOf(
            query(services, {
                workspaces: [ws('a'), ws('b', { label: 'Ledger' })],
                servicesFor: (id) => {
                    if (id === 'b') throw new Error('services_json is not JSON');
                    return (services as Record<string, DevServices>)[id] ?? {};
                },
            }),
        );
        expect(tenants).toEqual([]);
        expect(unreadable).toEqual(['Ledger']);
    });

    it('puts Genie Apps first — that is the fact that decides whether to press on', () => {
        const { tenants } = sliceTenantsOf(
            query(
                {
                    a: { 'svc-a': { ...PG16 } },
                    b: { 'svc-b': { ...PG16 } },
                    c: { 'svc-c': { ...PG16 } },
                },
                { workspaces: [ws('a'), ws('b'), ws('c', { label: 'Notes', appKind: 'app' })] },
            ),
        );
        expect(tenants.map((t) => t.workspaceId)).toEqual(['c', 'b']);
    });
});

describe('purgeVerdict', () => {
    const verdict = (tenancy: Parameters<typeof purgeVerdict>[0]['tenancy']) =>
        purgeVerdict({
            engine: 'postgres',
            version: '16',
            volume: 'genie-svc-postgres-16-data',
            tenancy,
        });

    it('allows a purge only when the tenancy was read IN FULL and came back empty', () => {
        expect(verdict({ tenants: [], unreadable: [] })).toEqual({ allowed: true });
    });

    it('refuses when the tenancy is UNKNOWN — guessing is what destroys data', () => {
        const v = verdict({ tenants: [], unreadable: ['Ledger'] });
        expect(v.allowed).toBe(false);
        expect(v.allowed === false && v.reason).toContain('Ledger');
        expect(v.allowed === false && v.reason).toMatch(/treated as occupied/i);
    });

    it('names the volume, the slice and the app whose data it protected', () => {
        const v = verdict({
            tenants: [
                {
                    workspaceId: 'c',
                    label: 'Notes',
                    identifier: 'ws_notes_1a2b3c4d',
                    appKind: 'app',
                },
            ],
            unreadable: [],
        });
        expect(v.allowed).toBe(false);
        const reason = v.allowed === false ? v.reason : '';
        expect(reason).toContain('genie-svc-postgres-16-data');
        expect(reason).toContain('ws_notes_1a2b3c4d');
        expect(reason).toContain('Notes');
        expect(reason).toMatch(/Genie App/);
        // …and what to do instead, so this never becomes a `force` flag.
        expect(reason).toMatch(/dedicated/);
    });

    it('does not claim an App is at stake when only ordinary workspaces are', () => {
        const v = verdict({
            tenants: [{ workspaceId: 'b', label: 'api', identifier: 'ws_api_9f8e7d6c' }],
            unreadable: [],
        });
        expect(v.allowed).toBe(false);
        expect(v.allowed === false && v.reason).not.toMatch(/Genie App/);
        expect(v.allowed === false && v.reason).toContain('ws_api_9f8e7d6c');
    });
});
