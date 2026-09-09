import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEnvReport } from '../../dev-server/services/service-manager';
import type { DevServiceRow } from '../../dev-server/services/service-manager';

/**
 * `manageService connection` MUST NOT REPORT SUCCESS-SHAPED NOTHING (genie#559).
 *
 * Measured on the owner's machine, in a workspace with three services enabled:
 *
 * ```json
 * "affectedId": "185a3d2442dc351d",
 * "env": {},
 * "ok": true
 * ```
 *
 * …in a payload whose own footer read `runtime: { kind: docker, version:
 * 29.6.1 }`. Genie had booted while the daemon was down, acquired nothing, and
 * `connection` reads the same empty map that terminal env is composed from — so
 * the tool an agent reaches for when injection yields nothing answered with the
 * same nothing, and said it had worked. Two agents spent an hour concluding they
 * were BLOCKED rather than that they were being told nothing.
 *
 * `hostEnvReportFor` already existed and its own doc says it carries *"the
 * counts that explain an EMPTY result"*. The honest variant was built; the
 * caller that most needed it was wired to the quiet one.
 *
 * The standing rule the issue produced, and the reason no test here asserts on
 * `ok` alone:
 *
 *   > **Assert on content, never on `ok`.** A boolean that reports transport
 *   > success while the payload is empty will pass every test anyone writes
 *   > against it.
 */

// --- the seams runManageService reaches through ------------------------------

const manager = vi.hoisted(() => ({
    list: vi.fn(),
    inventory: vi.fn(),
    refresh: vi.fn(),
    acquire: vi.fn(),
    release: vi.fn(),
    remove: vi.fn(),
    logs: vi.fn(),
    envFor: vi.fn(),
    hostEnvFor: vi.fn(),
    hostEnvReportFor: vi.fn(),
}));

const db = vi.hoisted(() => ({
    getWorkspaceDevServices: vi.fn(),
    listTerminalSpecs: vi.fn(),
}));

vi.mock('../../dev-server/services/service-manager', () => ({
    devServiceManager: () => manager,
}));
vi.mock('../../db', () => ({
    getWorkspaceDevServices: (...args: unknown[]) => db.getWorkspaceDevServices(...args),
    listTerminalSpecs: () => db.listTerminalSpecs(),
    setWorkspaceDevService: vi.fn(),
    setWorkspaceDevServices: vi.fn(),
    deleteWorkspaceDevService: vi.fn(),
}));
vi.mock('../dev-site-tools', () => ({
    runtimeInfo: async () => ({ kind: 'docker', version: '29.6.1' }),
}));
vi.mock('../host-tools', () => ({
    resolveAgentTarget: vi.fn(),
    callerSeesWholeWorkstation: () => false,
}));
vi.mock('../../terminal/ipc', () => ({ isTerminalLive: () => true }));
vi.mock('../../terminal/workspace-of-terminal', () => ({
    workspaceIdOfSpec: (spec: { workspace_id: string }) => spec.workspace_id,
}));

import { runManageService } from '../dev-service-tools';
import {
    forgetTerminalServiceEnv,
    recordTerminalServiceEnv,
} from '../../dev-server/services/stale-terminal-env';

// --- the machine these tests describe ----------------------------------------

const WS = { id: 'ws-acme', project_name: 'acme' };
const VIEW = { workspaceId: WS.id, wholeWorkstation: false };

const PG = {
    engine: 'postgres' as const,
    version: '17',
    dedicated: false,
    password: 'workspace_pw_0123456789',
    enabled: true,
};

const row = (over: Partial<DevServiceRow> = {}): DevServiceRow => ({
    serviceId: 'svc-pg',
    workspaceId: WS.id,
    engine: 'postgres',
    version: '17',
    engineKey: 'postgres-17',
    dedicated: false,
    enabled: true,
    state: 'failed',
    error: 'Docker is installed but its engine is not running.',
    ...over,
});

/** The manager holding NOTHING, in a workspace that enabled three services —
 *  the state measured on the machine. */
const HOLDING_NOTHING: HostEnvReport = {
    env: {},
    enabled: 3,
    live: 0,
    withHostPort: 0,
    gaps: [
        {
            engine: 'postgres',
            version: '17',
            reason: 'not-live',
            error: 'Docker is installed but its engine is not running.',
        },
        { engine: 'redis', version: '7', reason: 'not-live' },
        { engine: 'mailpit', version: '1', reason: 'not-live' },
    ],
};

beforeEach(() => {
    vi.clearAllMocks();
    forgetTerminalServiceEnv('term-old');
    db.getWorkspaceDevServices.mockReturnValue({ 'svc-pg': PG });
    db.listTerminalSpecs.mockReturnValue([]);
    manager.refresh.mockResolvedValue(undefined);
    manager.list.mockReturnValue([row()]);
    manager.envFor.mockReturnValue({});
    manager.hostEnvFor.mockReturnValue({});
    manager.hostEnvReportFor.mockReturnValue(HOLDING_NOTHING);
});

const connection = () =>
    runManageService(WS, { action: 'connection', id: 'svc-pg' }, VIEW);

describe('connection, when the manager is holding nothing', () => {
    it('does not report success, and says WHY the env is empty', async () => {
        const result = await connection();

        expect(result.env).toEqual({});
        // The counts that explain the emptiness travel WITH it, so a caller can
        // tell "Genie holds nothing" from "this workspace configured nothing"
        // without reading a second tool.
        expect(result.serviceEnv).toMatchObject({ enabled: 3, live: 0, withHostPort: 0 });
        expect(result.serviceEnv?.gaps.map((g) => g.engine)).toEqual([
            'postgres',
            'redis',
            'mailpit',
        ]);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/3/);
        expect(result.error).toMatch(/postgres/i);
        // The manager's own recorded diagnosis is the whole answer and used to
        // be thrown away.
        expect(result.error).toContain('Docker is installed but its engine is not running');
    });

    /**
     * POSITIVE CONTROL, and the distinction the fix turns on: `{}` is the RIGHT
     * answer for a workspace that enabled no services, and it must stay a
     * success. If both `{}`s reported the same thing the fix would have replaced
     * one indistinguishable pair with another.
     */
    it('still succeeds with an empty env when the workspace enabled nothing', async () => {
        manager.hostEnvReportFor.mockReturnValue({
            env: {},
            enabled: 0,
            live: 0,
            withHostPort: 0,
            gaps: [],
        });
        manager.list.mockReturnValue([row({ enabled: false, state: 'stopped', error: undefined })]);

        const result = await connection();

        expect(result.env).toEqual({});
        expect(result.serviceEnv).toMatchObject({ enabled: 0, gaps: [] });
        expect(result.ok).toBe(true);
        expect(result.error).toBeUndefined();
    });

    /** POSITIVE CONTROL: a workspace that IS holding its services answers with
     *  the connection, and carries the report saying nothing is missing. */
    it('hands back the connection when the services are live', async () => {
        manager.envFor.mockReturnValue({
            PGHOST: 'genie-svc-postgres-17',
            PGPORT: '5432',
            DATABASE_URL: 'postgres://acme@genie-svc-postgres-17:5432/acme',
        });
        manager.hostEnvReportFor.mockReturnValue({
            env: { PGHOST: '127.0.0.1', PGPORT: '49801' },
            enabled: 1,
            live: 1,
            withHostPort: 1,
            gaps: [],
        });
        manager.list.mockReturnValue([row({ state: 'running', ready: true, error: undefined })]);

        const result = await connection();

        expect(result.env).toMatchObject({ PGHOST: 'genie-svc-postgres-17' });
        expect(result.serviceEnv).toMatchObject({ enabled: 1, live: 1, gaps: [] });
        expect(result.ok).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it('tells the open terminals they are holding nothing either', async () => {
        // The detector's blind spot (genie#559): the live env is empty too, so a
        // terminal that received NOTHING used to compare as complete and this
        // field was absent exactly when it mattered most.
        db.listTerminalSpecs.mockReturnValue([{ id: 'term-old', workspace_id: WS.id }]);
        recordTerminalServiceEnv('term-old', {});

        const result = await connection();

        expect(result.terminalsMissingEnv).toContain('term-old');
        expect(result.terminalsMissingEnv).toContain('Postgres');
        // And it must NOT send them round the reopen loop: a new terminal would
        // inherit the same nothing until the engine is back.
        expect(result.terminalsMissingEnv).toMatch(/start the service/i);
    });
});

describe('list carries the same explanation', () => {
    it('reports the counts behind an empty service env', async () => {
        const result = await runManageService(WS, { action: 'list' }, VIEW);

        expect(result.serviceEnv).toMatchObject({ enabled: 3, live: 0, withHostPort: 0 });
        expect(result.services.map((s) => s.state)).toEqual(['failed']);
    });
});
