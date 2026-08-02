import { describe, expect, it } from 'vitest';
import { buildEngineInventory } from '../inventory';
import type { EngineInventoryInput } from '../inventory';
import type { DevServiceConfig } from '../services-config';

/**
 * THE MACHINE'S SERVICE INVENTORY (the workstation half of #234 P3).
 *
 * A service ENGINE is shared: one `postgres:16` container serves every
 * workspace pinned to Postgres 16. That single fact is why this exists. Every
 * other Dev Server surface asks a per-WORKSPACE question ("what does this
 * project serve, what does it connect to"), and none of them can answer the one
 * a person actually has when their machine feels heavy: *what is running on
 * this computer, and who is using it?* A workspace panel showing "Postgres 16 —
 * running" cannot say whether stopping it takes six other projects down with
 * it.
 *
 * The aggregation is pure so the three facts it has to keep straight are
 * assertable without Docker:
 *
 *   1. **installed ≠ running ≠ used.** An image can be pulled with no container;
 *      a container can be up with zero holders (it carries `restart:
 *      unless-stopped`, so a reboot brings it back before Genie is even open);
 *      a workspace can have an engine configured but disabled. Collapsing any
 *      pair of those into one status is how a user ends up deleting the wrong
 *      thing.
 *   2. **The refcount is WHO, not how many.** "Shared with 6 workspaces" is a
 *      number; "web, api, docs, …" is an answer.
 *   3. **A dedicated engine is a DIFFERENT container** with its own volume, so
 *      it is a separate row — never folded into the shared one's count.
 */

const password = 'pw';

const cfg = (over: Partial<DevServiceConfig> & Pick<DevServiceConfig, 'engine' | 'version'>):
    DevServiceConfig => ({
    dedicated: false,
    enabled: true,
    password,
    ...over,
});

/** The empty machine: no images, no containers, nothing configured. */
const bare: EngineInventoryInput = {
    configs: [],
    images: new Set<string>(),
    containers: new Map(),
    holders: new Map(),
};

const rowFor = (rows: ReturnType<typeof buildEngineInventory>, recordKey: string) =>
    rows.find((r) => r.recordKey === recordKey);

describe('buildEngineInventory', () => {
    it('lists every catalog engine+version as an available row, with nothing claimed', () => {
        // The "what could I run" half. A machine with no Docker images still has
        // to be able to say what the catalog offers, or the page is empty
        // exactly when a user most needs to be told what is possible.
        const rows = buildEngineInventory(bare);
        const pg16 = rowFor(rows, 'postgres-16');
        expect(pg16).toMatchObject({
            engine: 'postgres',
            version: '16',
            engineKey: 'postgres-16',
            image: 'postgres:16-alpine',
            installed: false,
            state: 'absent',
            holders: 0,
            configured: 0,
            dedicated: false,
        });
        // Every non-custom engine's every pinned version is offered.
        expect(rows.filter((r) => r.engine === 'postgres').map((r) => r.version)).toEqual([
            '17',
            '16',
            '15',
            '14',
        ]);
        // `custom` is not a catalog row: it has no image until a workspace names
        // one, so advertising it as "available" would be advertising nothing.
        expect(rows.some((r) => r.engine === 'custom')).toBe(false);
    });

    it('separates INSTALLED (image pulled) from RUNNING (container up)', () => {
        const rows = buildEngineInventory({
            ...bare,
            images: new Set(['postgres:16-alpine', 'redis:7-alpine']),
            containers: new Map([['genie-svc-postgres-16', { id: 'c1', state: 'running' }]]),
        });
        expect(rowFor(rows, 'postgres-16')).toMatchObject({
            installed: true,
            state: 'running',
            containerId: 'c1',
        });
        // Pulled but never started — a real state, and the one that explains
        // several gigabytes of disk that nothing is using.
        expect(rowFor(rows, 'redis-7')).toMatchObject({ installed: true, state: 'absent' });
        // Neither pulled nor running.
        expect(rowFor(rows, 'mysql-8.4')).toMatchObject({ installed: false, state: 'absent' });
    });

    it('reports a container that exists but is not up as STOPPED, not absent', () => {
        // `absent` and `stopped` need different buttons: one has to be created,
        // the other only started.
        const rows = buildEngineInventory({
            ...bare,
            containers: new Map([['genie-svc-postgres-16', { id: 'c1', state: 'exited' }]]),
        });
        expect(rowFor(rows, 'postgres-16')).toMatchObject({ state: 'stopped', containerId: 'c1' });
    });

    it('names the workspaces holding an engine, and counts them apart from the configured ones', () => {
        // THE reason this page exists. `holders` is who would be affected by a
        // stop RIGHT NOW; `configured` is who would be affected eventually.
        const rows = buildEngineInventory({
            ...bare,
            containers: new Map([['genie-svc-postgres-16', { id: 'c1', state: 'running' }]]),
            configs: [
                { workspaceId: 'w1', workspaceLabel: 'web', services: { s1: cfg({ engine: 'postgres', version: '16' }) } },
                { workspaceId: 'w2', workspaceLabel: 'api', services: { s2: cfg({ engine: 'postgres', version: '16' }) } },
                {
                    workspaceId: 'w3',
                    workspaceLabel: 'docs',
                    // Configured but OFF — counted as configured, never as a holder.
                    services: { s3: cfg({ engine: 'postgres', version: '16', enabled: false }) },
                },
            ],
            holders: new Map([['postgres-16', new Set(['w1', 'w2'])]]),
        });
        expect(rowFor(rows, 'postgres-16')).toMatchObject({
            holders: 2,
            configured: 3,
            workspaces: ['web', 'api', 'docs'],
        });
    });

    it('gives a DEDICATED engine its own row, and keeps it out of the shared one', () => {
        // A dedicated Postgres 16 is a different container with a different
        // volume. Counting its workspace against the shared engine would claim a
        // holder that would not be released by anything, and would make "stop
        // the shared engine" look more destructive than it is.
        const rows = buildEngineInventory({
            ...bare,
            containers: new Map([
                ['genie-svc-postgres-16', { id: 'shared', state: 'running' }],
                ['genie-svc-postgres-16-w9', { id: 'own', state: 'running' }],
            ]),
            configs: [
                { workspaceId: 'w1', workspaceLabel: 'web', services: { s1: cfg({ engine: 'postgres', version: '16' }) } },
                {
                    workspaceId: 'w9',
                    workspaceLabel: 'lab',
                    services: { s9: cfg({ engine: 'postgres', version: '16', dedicated: true }) },
                },
            ],
            holders: new Map([
                ['postgres-16', new Set(['w1'])],
                ['postgres-16@w9', new Set(['w9'])],
            ]),
        });
        expect(rowFor(rows, 'postgres-16')).toMatchObject({
            dedicated: false,
            holders: 1,
            configured: 1,
            workspaces: ['web'],
        });
        expect(rowFor(rows, 'postgres-16@w9')).toMatchObject({
            dedicated: true,
            ownerWorkspaceId: 'w9',
            holders: 1,
            configured: 1,
            workspaces: ['lab'],
            containerId: 'own',
        });
    });

    it('surfaces a CUSTOM image as its own row, carrying the image the workspace named', () => {
        const rows = buildEngineInventory({
            ...bare,
            configs: [
                {
                    workspaceId: 'w1',
                    workspaceLabel: 'web',
                    services: {
                        s1: cfg({
                            engine: 'custom',
                            version: 'custom',
                            dedicated: true,
                            image: 'ghcr.io/acme/thing:2',
                            port: 9000,
                        }),
                    },
                },
            ],
            images: new Set(['ghcr.io/acme/thing:2']),
        });
        const row = rowFor(rows, 'custom-custom@w1');
        expect(row).toMatchObject({
            engine: 'custom',
            image: 'ghcr.io/acme/thing:2',
            installed: true,
            dedicated: true,
            ownerWorkspaceId: 'w1',
        });
    });

    it('leads with what is running, then what is installed, then the rest', () => {
        // A machine-wide list is long. The rows that answer "what is eating my
        // laptop" have to be at the top without the user sorting anything.
        const rows = buildEngineInventory({
            ...bare,
            images: new Set(['mysql:8.4']),
            containers: new Map([['genie-svc-redis-7', { id: 'c1', state: 'running' }]]),
        });
        expect(rows[0]?.recordKey).toBe('redis-7');
        expect(rows[1]?.recordKey).toBe('mysql-8.4');
    });

    it('reports the images it needs probed, so nothing is downloaded to answer', () => {
        // The caller asks the runtime `imageExists` for exactly these. A page
        // that pulled an image because someone opened it would be a
        // multi-gigabyte surprise.
        const wanted = buildEngineInventory({
            ...bare,
            configs: [
                {
                    workspaceId: 'w1',
                    workspaceLabel: 'web',
                    services: {
                        s1: cfg({
                            engine: 'custom',
                            version: 'custom',
                            dedicated: true,
                            image: 'ghcr.io/acme/thing:2',
                        }),
                    },
                },
            ],
        }).map((r) => r.image);
        expect(wanted).toContain('postgres:16-alpine');
        expect(wanted).toContain('ghcr.io/acme/thing:2');
    });
});
