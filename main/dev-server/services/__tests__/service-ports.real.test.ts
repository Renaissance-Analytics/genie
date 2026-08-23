import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { createDockerRuntime } from '../../docker-adapter';
import { isPortFree, waitForPort } from '../../port-probe';
import { createDevServiceManager } from '../service-manager';
import { preferredServicePort } from '../service-ports';
import { createServiceEnvSync } from '../env-sync';
import { engineKeyFor } from '../catalog';
import { serviceContainerNameFor, serviceVolumeNameFor } from '../../argv';
import { applyEnvBlock } from '../../../env-store';
import { cleanupTmpRoot, makeTmpDir } from '../../../../test/helpers';
import type { DevServiceManager } from '../service-manager';
import type { DevServices } from '../services-config';
import type { DevSites } from '../../sites-config';
import type { RuntimeDetection } from '../../container-runtime';

/**
 * REAL DOCKER: the published port does not move, and the `.env` follows it when it
 * genuinely has to (genie#242 follow-up).
 *
 * The unit suite proves the DECISION with a fake runtime, and the hosting E2E mocks
 * the container layer entirely — so neither has ever bound a port, and neither would
 * have caught a publication Docker refuses to honour. That gap is not hypothetical:
 * beta.230 shipped a hosting change validated exactly that way and killed live
 * sites, and the stale-port bug itself (`.env` saying 51157 while Postgres answered
 * on 58377) survived a green unit suite for a week.
 *
 * So this drives the ACTUAL `createDevServiceManager` over the ACTUAL docker CLI
 * adapter, with the ACTUAL `isPortFree` bind probe and the ACTUAL `applyEnvBlock`
 * writing a real file on a real disk. What it asserts is the owner's requirement,
 * end to end:
 *
 *   1. the engine is published on the DERIVED port and is genuinely dialable there;
 *   2. destroying and re-acquiring it — which is what a Genie restart does, and what
 *      used to hand out a brand-new number — lands on the SAME port;
 *   3. when that port is genuinely taken, the engine MOVES, comes up anyway, and the
 *      repo's `.env` is rewritten to where it actually went.
 *
 * A DEDICATED engine on a per-run workspace id, so the container, the volume and the
 * derived port all belong to this test and it can never touch (or adopt, or delete)
 * a real `genie-svc-redis-*` on the machine.
 */

const hasDocker = (() => {
    try {
        return (
            spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
                stdio: 'ignore',
                timeout: 15_000,
            }).status === 0
        );
    } catch {
        return false;
    }
})();

const DOCKER: RuntimeDetection = { kind: 'docker', version: 'real', probes: [] };
const VERSION = '7';
const ENGINE_KEY = engineKeyFor('redis', VERSION);
const WS = `svcports${Date.now().toString(36)}`;
const RECORD_KEY = `${ENGINE_KEY}@${WS}`;
const CONTAINER = serviceContainerNameFor(ENGINE_KEY, WS);
const DERIVED = preferredServicePort(RECORD_KEY, 'redis');

const runtime = createDockerRuntime();

/** A dedicated redis, so nothing on this machine is shared, adopted or removed. */
const services: DevServices = {
    'svc-redis': {
        engine: 'redis',
        version: VERSION,
        dedicated: true,
        active: true,
        // Base64url-shaped, like the real generator — `provision.ts` refuses a
        // password that does not look minted.
        password: 'ws_pw_Aa0Bb1Cc2Dd3Ee4Ff5Gg6',
        enabled: true,
    },
};

const sites: DevSites = {
    s1: { name: 'app', genName: 'app.gen', repo: 'app', runMode: 'host' } as DevSites[string],
};

interface Harness {
    manager: DevServiceManager;
    root: string;
    envFile: string;
    ledger: Record<string, Record<string, number>>;
}

/** Stand the REAL manager up over the REAL runtime, writing a REAL `.env`. */
function harness(ledger: Record<string, Record<string, number>> = {}): Harness {
    const root = makeTmpDir('svcports-ws');
    fs.mkdirSync(path.join(root, 'repos', 'app'), { recursive: true });
    let manager: DevServiceManager;
    manager = createDevServiceManager({
        resolveRuntime: async () => ({ runtime, detection: DOCKER }),
        listWorkspaces: () => [{ id: WS, path: root, label: WS }],
        devServicesFor: () => services,
        engineAdmin: () => ({ user: 'default', password: 'admin_pw_Zz9Yy8Xx7Ww6Vv5Uu4Tt3' }),
        probeReady: ({ port, timeoutMs }) => waitForPort(port, timeoutMs),
        readyTimeoutMs: 30_000,
        // The REAL bind probe and the REAL ledger contract.
        isPortFree,
        servicePorts: {
            read: (key) => ledger[key] ?? {},
            save: (key, ports) => {
                ledger[key] = { ...(ledger[key] ?? {}), ...ports };
            },
        },
        // The REAL `.env` writer, through the REAL composition.
        onServiceEnvChanged: createServiceEnvSync({
            workspaceFor: () => ({ path: root }),
            devSitesFor: () => sites,
            hostEnvFor: (id) => manager.hostEnvFor(id),
            write: applyEnvBlock,
        }),
    });
    return { manager, root, envFile: path.join(root, 'repos', 'app', '.env'), ledger };
}

async function destroyEngine(): Promise<void> {
    const found = (await runtime.psServices(ENGINE_KEY).catch(() => [])).find(
        (c) => c.name === CONTAINER,
    );
    if (found) {
        await runtime.stop(found.id).catch(() => {});
        await runtime.remove(found.id).catch(() => {});
    }
    await runtime.volumeRemove(serviceVolumeNameFor(ENGINE_KEY, 'data', WS)).catch(() => {});
}

afterAll(async () => {
    if (hasDocker) await destroyEngine();
    cleanupTmpRoot();
});

describe.skipIf(!hasDocker)('REAL Docker: a service port that does not move', () => {
    it(
        'publishes on the DERIVED port, is dialable there, and says so in the repo .env',
        async () => {
            await destroyEngine();
            const h = harness();

            const status = await h.manager.acquire(WS, 'svc-redis');

            expect(status.state).toBe('running');
            const endpoint = status.endpoints?.find((e) => e.name === 'redis');
            // Docker was ASKED for this number and gave it — not "some port appeared".
            expect(endpoint?.hostPort).toBe(DERIVED);
            // And something is really listening on it.
            expect(await waitForPort(DERIVED, 10_000)).toBe(true);
            // The file the application reads names the port it can actually reach.
            expect(fs.readFileSync(h.envFile, 'utf8')).toContain(`REDIS_PORT=${DERIVED}`);
            expect(h.ledger[RECORD_KEY]).toEqual({ redis: DERIVED });
        },
        120_000,
    );

    it(
        'lands on the SAME port after the container is destroyed and re-acquired',
        async () => {
            // This is the whole requirement. Destroying and re-creating the engine is
            // exactly what a Genie restart used to do, and it is where the number
            // used to change — 51157 one day, 58377 the next, with the `.env` and
            // every running process still pointing at the old one.
            await destroyEngine();
            const first = harness();
            const before = await first.manager.acquire(WS, 'svc-redis');
            expect(before.state).toBe('running');

            // A fresh Genie: new manager, EMPTY ledger, container gone. Nothing but
            // the derivation carries the number across.
            await destroyEngine();
            const second = harness();
            const after = await second.manager.acquire(WS, 'svc-redis');

            expect(after.state).toBe('running');
            expect(after.endpoints?.find((e) => e.name === 'redis')?.hostPort).toBe(
                before.endpoints?.find((e) => e.name === 'redis')?.hostPort,
            );
            expect(await waitForPort(DERIVED, 10_000)).toBe(true);
        },
        180_000,
    );

    it(
        'does not restart a healthy engine on the next acquire',
        async () => {
            // A running engine OCCUPIES its own published port, so a freeness probe
            // on the next acquire says "taken" — about itself. An earlier draft of
            // this change planned from that answer, decided the healthy container
            // was on the wrong port, and destroyed and re-created the database on
            // EVERY acquire. Nothing with a fake runtime could see it: only a real
            // bind against a real published port answers "taken" here.
            await destroyEngine();
            const h = harness();

            const first = await h.manager.acquire(WS, 'svc-redis');
            expect(first.state).toBe('running');
            const id = first.containerId;

            const second = await h.manager.acquire(WS, 'svc-redis');

            expect(second.state).toBe('running');
            // The SAME container, still up, on the same port.
            expect(second.containerId).toBe(id);
            expect(second.endpoints?.find((e) => e.name === 'redis')?.hostPort).toBe(DERIVED);
            expect(await waitForPort(DERIVED, 10_000)).toBe(true);
        },
        180_000,
    );

    it(
        'MOVES when its port is genuinely taken, comes up anyway, and rewrites the .env to where it went',
        async () => {
            // "Actually move a port and observe what happens end to end": squat on the
            // derived port with a real listener, then bring the engine up.
            await destroyEngine();
            const squatter = net.createServer();
            await new Promise<void>((resolve, reject) => {
                squatter.once('error', reject);
                squatter.listen(DERIVED, '127.0.0.1', () => resolve());
            });

            try {
                const h = harness();
                const status = await h.manager.acquire(WS, 'svc-redis');

                // It came up. A collision is a move, not an outage.
                expect(status.state).toBe('running');
                const moved = status.endpoints?.find((e) => e.name === 'redis')?.hostPort;
                expect(moved).toBeDefined();
                expect(moved).not.toBe(DERIVED);
                // Reachable at the NEW address...
                expect(await waitForPort(moved as number, 10_000)).toBe(true);
                // ...and the app's own configuration file agrees, with no restart, no
                // re-run, and nothing hand-edited.
                expect(fs.readFileSync(h.envFile, 'utf8')).toContain(`REDIS_PORT=${moved}`);
                // Remembered, so it does not hop BACK when the squatter leaves.
                expect(h.ledger[RECORD_KEY]).toEqual({ redis: moved });
            } finally {
                await new Promise<void>((resolve) => squatter.close(() => resolve()));
            }
        },
        180_000,
    );
});
