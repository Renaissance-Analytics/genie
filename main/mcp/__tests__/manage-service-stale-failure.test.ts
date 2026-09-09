import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerRuntime, RuntimeDetection } from '../../dev-server/container-runtime';
import type {
    DevServiceManager,
    DevServiceManagerDeps,
} from '../../dev-server/services/service-manager';
import type { ManageServiceResult } from '../protocol';

/**
 * ONE RESPONSE MAY NOT ASSERT BOTH THAT DOCKER IS RUNNING AND THAT IT IS NOT
 * (genie#558).
 *
 * What shipped, measured on the owner's machine with five containers up:
 *
 * ```
 * state: "failed"
 * error: "Docker is installed but its engine is not running — start Docker
 *         Desktop and wait for the whale to settle, then try again."
 * runtime: { kind: "docker", version: "29.6.1" }
 * ```
 *
 * The rows came from the service manager's remembered failures, recorded when
 * the boot pass raced Docker Desktop's own startup and never revisited. The
 * footer came from a separately cached probe. **Two independent observations of
 * one machine, in one payload, disagreeing** — and the half that was wrong
 * prescribed restarting Docker Desktop, which stops the Postgres five
 * workspaces share, at the moment `start` would have worked first time.
 *
 * So this file tests an INVARIANT, not a happy path: within one response, the
 * runtime the rows were derived under IS the runtime reported. It is checked in
 * both directions, because a fix that simply stopped reporting failures would
 * satisfy a one-directional version of it while destroying the diagnosis.
 */

let managerInstance: DevServiceManager | null = null;

vi.mock('../../dev-server/services/service-manager', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('../../dev-server/services/service-manager')>();
    return { ...actual, devServiceManager: () => managerInstance };
});
vi.mock('../../db', () => ({
    getWorkspaceDevServices: () => ({ 'svc-pg': PG }),
    listTerminalSpecs: () => [],
    setWorkspaceDevService: vi.fn(),
    setWorkspaceDevServices: vi.fn(),
    deleteWorkspaceDevService: vi.fn(),
}));
// Deliberately WRONG, and deliberately never agreeing with the manager: this is
// the independently-cached probe the footer used to come from. If any assertion
// below sees these values, the two halves are still two observations.
vi.mock('../dev-site-tools', () => ({
    runtimeInfo: async () => ({ kind: 'stale-cache', version: '0.0.0' }),
}));
vi.mock('../host-tools', () => ({
    resolveAgentTarget: vi.fn(),
    callerSeesWholeWorkstation: () => false,
}));
vi.mock('../../terminal/ipc', () => ({ isTerminalLive: () => true }));
vi.mock('../../terminal/workspace-of-terminal', () => ({
    workspaceIdOfSpec: (spec: { workspace_id: string }) => spec.workspace_id,
}));

import { createDevServiceManager } from '../../dev-server/services/service-manager';
import { runManageService } from '../dev-service-tools';

// --- the machine ------------------------------------------------------------

const WS = { id: 'ws-acme', project_name: 'acme' };
const VIEW = { workspaceId: WS.id, wholeWorkstation: false };

const PG = {
    engine: 'postgres' as const,
    version: '17',
    dedicated: false,
    password: 'workspace_pw_0123456789',
    enabled: true,
};

const DOCKER_UP: RuntimeDetection = { kind: 'docker', version: '29.6.1', probes: [] };
const DOCKER_DOWN: RuntimeDetection = {
    kind: 'none',
    reason: 'not-running',
    installHint:
        'Docker is installed but its engine is not running — start Docker Desktop and wait for ' +
        'the whale to settle, then try again.',
    probes: [],
};

/**
 * The daemon, flipped by the test.
 *
 * No container runtime object is ever needed: while it is DOWN nothing can be
 * called, and once it is UP the manager holds nothing, so `refresh` observes the
 * verdict and has no engines to sweep. The observation is the whole subject.
 */
let dockerUp = false;
const runtimeStub = {} as ContainerRuntime;

const managerDeps = (): DevServiceManagerDeps => ({
    resolveRuntime: async () =>
        dockerUp
            ? { runtime: runtimeStub, detection: DOCKER_UP }
            : { runtime: null, detection: DOCKER_DOWN },
    listWorkspaces: () => [{ id: WS.id, path: '/work/acme', label: 'acme' }],
    devServicesFor: () => ({ 'svc-pg': PG }),
    engineAdmin: (req) => ({ user: req.adminUser, password: `admin_pw_${req.recordKey}` }),
});

beforeEach(() => {
    dockerUp = false;
    managerInstance = createDevServiceManager(managerDeps());
});

const list = (): Promise<ManageServiceResult> =>
    runManageService(WS, { action: 'list' }, VIEW);

/**
 * The invariant itself. A row may only claim the engine is unavailable in a
 * response that says the engine is unavailable.
 */
function assertNoContradiction(result: ManageServiceResult): void {
    const runtimeIsUp = result.runtime?.kind !== undefined && result.runtime.kind !== 'none';
    const claimingNoEngine = result.services.filter(
        (s) => s.state === 'failed' && /engine is not running|no container runtime/i.test(s.error ?? ''),
    );
    if (runtimeIsUp && claimingNoEngine.length > 0) {
        throw new Error(
            `Contradiction: runtime reported as ${JSON.stringify(result.runtime)} while ` +
                `${claimingNoEngine.length} service(s) report the engine is not running: ` +
                claimingNoEngine.map((s) => `${s.id} — ${s.error}`).join('; '),
        );
    }
}

describe('the stale "engine is not running" verdict', () => {
    it('is gone once an engine is running, and the runtime reported is the one it was read under', async () => {
        // The boot attempt, racing Docker Desktop's startup.
        await managerInstance?.acquire(WS.id, 'svc-pg');
        const whileDown = await list();
        expect(whileDown.services[0]).toMatchObject({
            state: 'failed',
            error: expect.stringContaining('its engine is not running'),
        });
        expect(whileDown.runtime).toMatchObject({ kind: 'none' });
        assertNoContradiction(whileDown);

        // Docker answers. Nothing re-attempts anything: the verdict the failure
        // was recorded under is gone, so the claim is withdrawn.
        dockerUp = true;
        const whenUp = await list();

        expect(whenUp.runtime).toMatchObject({ kind: 'docker', version: '29.6.1' });
        expect(whenUp.services[0].state).toBe('stopped');
        expect(whenUp.services[0].error).toBeUndefined();
        assertNoContradiction(whenUp);
    });

    /**
     * POSITIVE CONTROL, and the direction that matters most: the honest pairing
     * must still be REACHABLE. A "fix" that stopped reporting failures at all
     * would pass every no-contradiction assertion above while destroying the one
     * message that tells an operator what is wrong.
     */
    it('still says the engine is down, with the remedy, while it IS down', async () => {
        await managerInstance?.acquire(WS.id, 'svc-pg');
        const result = await list();

        expect(result.services[0]).toMatchObject({
            state: 'failed',
            error: expect.stringContaining('start Docker Desktop'),
        });
        expect(result.runtime).toMatchObject({ kind: 'none' });
        // …and the response says WHEN, so a reader can judge the age of the
        // claim rather than take it as the present tense.
        expect(result.services[0].failedAt).toBeGreaterThan(0);
    });

    /**
     * The footer and the rows come from ONE observation. `runtimeInfo` is mocked
     * to a value that could not possibly be right; seeing it here would mean the
     * two halves are still independent and can still disagree.
     */
    it('never reports the separately-cached probe alongside the manager rows', async () => {
        dockerUp = true;
        const result = await list();

        expect(result.runtime?.kind).not.toBe('stale-cache');
        expect(result.runtime).toMatchObject({ kind: 'docker', version: '29.6.1' });
    });

    /** A manager that has observed nothing yet cannot invent a verdict — the
     *  cached probe is the honest fallback there, not a contradiction. */
    it('falls back to the cached probe when there is no manager at all', async () => {
        managerInstance = null;
        const result = await runManageService(WS, { action: 'list' }, VIEW);

        expect(result.ok).toBe(false);
        expect(result.runtime).toMatchObject({ kind: 'stale-cache' });
    });
});
