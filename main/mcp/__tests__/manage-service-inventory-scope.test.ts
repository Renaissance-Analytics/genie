import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineInventoryRow } from '../../dev-server/services/inventory';
import type { DevServiceRow } from '../../dev-server/services/service-manager';

/**
 * WHO an `inventory` is allowed to see (genie#345).
 *
 * `manageService(action:'inventory')` is the one MACHINE-level read in an
 * otherwise per-workspace tool, and it used to hand every agent on the
 * workstation the other workspaces' NAMES, their ids, and their containers. An
 * agent should never be shown a resource it can neither use nor touch: all it
 * can do with one is reason about work that is not its own.
 *
 * The hazard the disclosure was there to prevent is real and must survive the
 * fix — *"without it an agent can stop an engine five other workspaces are
 * using and report success."* But the question an agent has to be able to ask is
 * **"is anyone else on this engine?"**, and that is answerable without saying
 * WHO. Identity is not needed to make the safe decision, only the unsafe one.
 *
 * So the split this file pins down is the same one `actionableWorkspaces()`
 * already draws for `manageWorkspaces`: the workstation operator sees the
 * machine, and everybody else sees their own workspace plus counts.
 */

// --- the seams manageServiceForMcp reaches through --------------------------

const manager = vi.hoisted(() => ({
    list: vi.fn(),
    inventory: vi.fn(),
    refresh: vi.fn(),
    acquire: vi.fn(),
    release: vi.fn(),
    remove: vi.fn(),
    logs: vi.fn(),
    envFor: vi.fn(),
}));

const hostTools = vi.hoisted(() => ({
    resolveAgentTarget: vi.fn(),
    callerSeesWholeWorkstation: vi.fn(),
}));

vi.mock('../../dev-server/services/service-manager', () => ({
    devServiceManager: () => manager,
}));
vi.mock('../../db', () => ({
    getWorkspaceDevServices: () => ({}),
    setWorkspaceDevService: vi.fn(),
    setWorkspaceDevServices: vi.fn(),
    deleteWorkspaceDevService: vi.fn(),
}));
vi.mock('../dev-site-tools', () => ({
    runtimeInfo: async () => ({ kind: 'docker', version: '29.6.1' }),
}));
vi.mock('../host-tools', () => hostTools);

import { manageServiceForMcp } from '../dev-service-tools';

// --- the machine these tests describe ---------------------------------------
//
// Three workspaces. `acme` is the caller throughout; `beta` and `gamma` are the
// neighbours whose existence must not reach it.

const ACME = { id: 'ws-acme', project_name: 'acme' };

const engine = (over: Partial<EngineInventoryRow>): EngineInventoryRow => ({
    recordKey: 'postgres-16',
    engineKey: 'postgres-16',
    engine: 'postgres',
    version: '16',
    label: 'PostgreSQL',
    summary: 'The relational database most stacks default to.',
    provision: 'sql-database-role',
    image: 'postgres:16-alpine',
    containerName: 'genie-svc-postgres-16',
    installed: true,
    state: 'running',
    dedicated: false,
    holders: 0,
    configured: 0,
    workspaces: [],
    workspaceIds: [],
    ...over,
});

/** Shared Postgres 16 — acme AND both neighbours. The row the safety property
 *  hangs on: stopping it stops it for three workspaces. */
const SHARED_WITH_OTHERS = engine({
    holders: 3,
    configured: 3,
    workspaces: ['acme', 'beta', 'gamma'],
    workspaceIds: ['ws-acme', 'ws-beta', 'ws-gamma'],
    containerId: 'container-pg16',
});

/** Shared MySQL 8 — held by a NEIGHBOUR only. acme is not on it, so a naive
 *  "holders: 1 must be me" reading would be exactly wrong. */
const SHARED_BY_A_NEIGHBOUR_ONLY = engine({
    recordKey: 'mysql-8',
    engineKey: 'mysql-8',
    engine: 'mysql',
    version: '8',
    label: 'MySQL',
    image: 'mysql:8',
    containerName: 'genie-svc-mysql-8',
    holders: 1,
    configured: 1,
    workspaces: ['beta'],
    workspaceIds: ['ws-beta'],
});

/** A DEDICATED engine belonging to a neighbour. Its recordKey and its container
 *  name both carry that workspace's id, so there is nothing here to redact —
 *  the row itself is the disclosure. */
const NEIGHBOURS_DEDICATED = engine({
    recordKey: 'redis-7@ws-beta',
    engineKey: 'redis-7',
    engine: 'redis',
    version: '7',
    label: 'Redis',
    image: 'redis:7-alpine',
    containerName: 'genie-svc-redis-7-ws-beta',
    containerId: 'container-redis-beta',
    dedicated: true,
    ownerWorkspaceId: 'ws-beta',
    holders: 1,
    configured: 1,
    workspaces: ['beta'],
    workspaceIds: ['ws-beta'],
});

/** acme's OWN dedicated engine — the caller's, and fully theirs to see. */
const OWN_DEDICATED = engine({
    recordKey: 'redis-7@ws-acme',
    engineKey: 'redis-7',
    engine: 'redis',
    version: '7',
    label: 'Redis',
    image: 'redis:7-alpine',
    containerName: 'genie-svc-redis-7-ws-acme',
    containerId: 'container-redis-acme',
    dedicated: true,
    ownerWorkspaceId: 'ws-acme',
    holders: 1,
    configured: 1,
    workspaces: ['acme'],
    workspaceIds: ['ws-acme'],
});

/** A catalog row: nothing configured it, nothing is running it. */
const NOBODY_HAS_IT = engine({
    recordKey: 'postgres-17',
    engineKey: 'postgres-17',
    version: '17',
    image: 'postgres:17-alpine',
    containerName: 'genie-svc-postgres-17',
    installed: false,
    state: 'absent',
});

const MACHINE = [
    SHARED_WITH_OTHERS,
    SHARED_BY_A_NEIGHBOUR_ONLY,
    NEIGHBOURS_DEDICATED,
    OWN_DEDICATED,
    NOBODY_HAS_IT,
];

/** acme's own Postgres service, as `manager.list(ws.id)` reports it. The
 *  POSITIVE CONTROL: "no neighbour appears" passes just as well against an
 *  empty result, so every leak assertion runs beside proof that this call
 *  really did return acme's own, fully-detailed service. */
const ACMES_OWN_SERVICE: DevServiceRow = {
    serviceId: 'svc-acme-postgres-16',
    workspaceId: 'ws-acme',
    engine: 'postgres',
    version: '16',
    engineKey: 'postgres-16',
    dedicated: false,
    enabled: true,
    state: 'running',
    ready: true,
    holders: 3,
    containerName: 'genie-svc-postgres-16',
    endpoints: [
        {
            name: 'postgres',
            kind: 'tcp',
            host: 'genie-svc-postgres-16',
            port: 5432,
            localAddress: '127.0.0.1:54321',
        },
    ],
    envKeys: ['DATABASE_URL'],
};

beforeEach(() => {
    manager.list.mockReset().mockReturnValue([ACMES_OWN_SERVICE]);
    manager.inventory.mockReset().mockResolvedValue(MACHINE);
    hostTools.resolveAgentTarget.mockReset().mockResolvedValue({
        decision: { allowed: true, workspaceId: ACME.id, reason: 'own', via: 'self' },
        ws: ACME,
    });
    hostTools.callerSeesWholeWorkstation.mockReset().mockReturnValue(false);
});

// --- a workspace agent ------------------------------------------------------

describe('a workspace agent reading the workstation inventory', () => {
    it('is told nothing about a neighbour — while still getting its OWN inventory', async () => {
        const res = await manageServiceForMcp('term-acme', { action: 'inventory' });

        // POSITIVE CONTROL first: this is a real, populated answer, not the
        // empty payload that would satisfy every absence check below.
        expect(res.ok).toBe(true);
        expect(res.engines?.length ?? 0).toBeGreaterThan(0);
        expect(res.engines?.map((e) => e.recordKey)).toContain('postgres-16');
        expect(res.services).toEqual([
            expect.objectContaining({
                id: 'svc-acme-postgres-16',
                engine: 'postgres',
                state: 'running',
                envKeys: ['DATABASE_URL'],
                endpoints: [expect.objectContaining({ port: 5432 })],
            }),
        ]);

        // And now the leak. Over the WHOLE payload, because a name can escape
        // through any field — `workspaces`, a recordKey, a container name.
        const wire = JSON.stringify(res);
        expect(wire).not.toContain('beta');
        expect(wire).not.toContain('gamma');
        expect(res.engines?.find((e) => e.recordKey === 'postgres-16')?.workspaces).toBeUndefined();
    });

    it("drops a neighbour's DEDICATED engine outright — its identity IS its record", async () => {
        const res = await manageServiceForMcp('term-acme', { action: 'inventory' });
        const keys = res.engines?.map((e) => e.recordKey) ?? [];

        expect(keys).not.toContain('redis-7@ws-beta');
        // The caller's own dedicated engine is not collateral damage: it stays,
        // and it still names its owner, because that owner is the caller.
        expect(keys).toContain('redis-7@ws-acme');
        expect(res.engines?.find((e) => e.recordKey === 'redis-7@ws-acme')).toMatchObject({
            ownerWorkspaceId: 'ws-acme',
            containerName: 'genie-svc-redis-7-ws-acme',
        });
    });

    it('can still tell a SHARED engine is in use by someone else, so it cannot stop it and report success', async () => {
        const res = await manageServiceForMcp('term-acme', { action: 'inventory' });
        const by = (key: string) => res.engines?.find((e) => e.recordKey === key);

        // The reference count survives — it is the fact that makes a release
        // honest — and `sharedWithOthers` says whose 1 the 1 is.
        expect(by('postgres-16')).toMatchObject({ holders: 3, sharedWithOthers: true });
        // Held by exactly ONE workspace, and that workspace is NOT the caller.
        // A count alone reads as "just me"; this is the field that stops that.
        expect(by('mysql-8')).toMatchObject({ holders: 1, sharedWithOthers: true });
        // The caller's own dedicated engine is genuinely theirs alone.
        expect(by('redis-7@ws-acme')).toMatchObject({ holders: 1, sharedWithOthers: false });
        // And an engine nobody has configured is nobody's.
        expect(by('postgres-17')).toMatchObject({ holders: 0, sharedWithOthers: false });
    });

    it('refuses inventory to a caller whose workspace could not be resolved', async () => {
        // A machine-wide read was the ONE thing an unattached caller could get
        // without any authorization being consulted at all.
        hostTools.resolveAgentTarget.mockResolvedValue({
            decision: {
                allowed: false,
                workspaceId: '',
                reason: 'This terminal is not attached to a Genie workspace, so it has no authority to act on one.',
                via: 'denied',
            },
            ws: null,
        });
        const res = await manageServiceForMcp('term-nowhere', { action: 'inventory' });
        expect(res.ok).toBe(false);
        expect(res.engines).toBeUndefined();
        expect(res.error).toMatch(/not attached to a Genie workspace/);
    });

    it('still answers `catalog` with no workspace — it is static, and discloses nobody', async () => {
        hostTools.resolveAgentTarget.mockResolvedValue({
            decision: { allowed: false, workspaceId: '', reason: 'unresolved', via: 'denied' },
            ws: null,
        });
        const res = await manageServiceForMcp('term-nowhere', { action: 'catalog' });
        expect(res.ok).toBe(true);
        expect(res.catalog?.length ?? 0).toBeGreaterThan(0);
    });
});

// --- the workstation operator ------------------------------------------------

describe('the workstation operator', () => {
    it('keeps the whole-machine view, names and all', async () => {
        // The fix must not be "hide it from everyone": the operator is exactly
        // the caller whose job needs the machine, which is the same exception
        // `actionableWorkspaces()` makes for manageWorkspaces.
        hostTools.callerSeesWholeWorkstation.mockReturnValue(true);
        const res = await manageServiceForMcp('term-osa', { action: 'inventory' });

        expect(res.engines?.map((e) => e.recordKey)).toEqual([
            'postgres-16',
            'mysql-8',
            'redis-7@ws-beta',
            'redis-7@ws-acme',
            'postgres-17',
        ]);
        expect(res.engines?.find((e) => e.recordKey === 'postgres-16')?.workspaces).toEqual([
            'acme',
            'beta',
            'gamma',
        ]);
        expect(res.engines?.find((e) => e.recordKey === 'redis-7@ws-beta')).toMatchObject({
            ownerWorkspaceId: 'ws-beta',
        });
    });

    it('reads the machine even though it belongs to NO workspace', async () => {
        // The OS Agent's terminal is deliberately `workspace_id: null` — the
        // machine IS its scope, and `resolveAgentTarget` denies it like any
        // other unattached caller. Making `inventory` require a resolved
        // workspace must not lock out the one caller the whole-machine view
        // exists for.
        hostTools.callerSeesWholeWorkstation.mockReturnValue(true);
        hostTools.resolveAgentTarget.mockResolvedValue({
            decision: {
                allowed: false,
                workspaceId: '',
                reason: 'This terminal is not attached to a Genie workspace, so it has no authority to act on one.',
                via: 'denied',
            },
            ws: null,
        });
        const res = await manageServiceForMcp('term-osa', { action: 'inventory' });

        expect(res.ok).toBe(true);
        expect(res.engines?.map((e) => e.recordKey)).toContain('redis-7@ws-beta');
        // It has no workspace, so there is no per-workspace service list to give
        // — the machine view is the whole of the answer.
        expect(res.services).toEqual([]);
    });

    it('is asked about the CALLER, never about the request', async () => {
        // The authority has to come from what the machine was configured to
        // trust. A workspaceId in the arguments must not be able to buy it.
        await manageServiceForMcp('term-acme', { action: 'inventory' });
        expect(hostTools.callerSeesWholeWorkstation).toHaveBeenCalledWith('term-acme');
    });
});
