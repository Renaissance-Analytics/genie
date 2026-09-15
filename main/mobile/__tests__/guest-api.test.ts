import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import { Readable } from 'node:stream';

/**
 * A GUEST on the host's REST surface — someone a workstation was shared with,
 * connected over the relay with a grant for ONE workspace (genie-cloud#33).
 *
 * The host used to judge a guest by nothing at all: every relay member rode one
 * owner session, so the only scope check was a `workspaceId` TAG the member wrote
 * on its own frames. These pin the replacement, which judges the RESOURCE a
 * request reaches:
 *
 *  1. Listings are FILTERED: an out-of-scope workspace is invisible, not merely
 *     refused — a guest must not learn the owner's other project names.
 *  2. A request aimed at an out-of-scope workspace, terminal, process, question,
 *     list item, agent or site is answered like an unknown one (404) and NOTHING
 *     runs — the host's deps are never called.
 *  3. Host management is refused outright (403): Genie's settings, the updater,
 *     plugins, Tynn provisioning, AgentInbox (it posts as the owner), setup,
 *     session save — and any route the gate does not know, by default.
 *  4. A READ-ONLY guest reads its workspace and changes nothing.
 *  5. The owner's own paired device is untouched (positive control throughout).
 *
 * Every refusal is checked against a spy that would have recorded the action, so
 * a refusal that still ran the action cannot pass.
 */

const db = vi.hoisted(() => ({
    listWorkspaces: vi.fn(),
    listTerminalSpecs: vi.fn(),
    getTerminalSpec: vi.fn(),
    getAllSettings: vi.fn(() => ({ ai_system: 'owner instructions' })),
    createTerminalSpec: vi.fn(),
    updateTerminalSpec: vi.fn(),
    deleteTerminalSpec: vi.fn(),
    touchTerminalSpec: vi.fn(),
    reorderTerminalSpecs: vi.fn(),
}));
vi.mock('../../db', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../db')>()),
    ...db,
}));

const lists = vi.hoisted(() => ({
    readWorkspaceLists: vi.fn((_workspaceId: string) => ({ agents: [], user: [], userCount: 0 })),
    resolveUserListItemOnHost: vi.fn(() => ({ ok: true, nudge: { delivered: true } })),
    workspaceOfListItem: vi.fn(),
}));
vi.mock('../../lists/wiring', () => lists);

const agents = vi.hoisted(() => ({ getWorkspaceAgentById: vi.fn() }));
vi.mock('../../agents/lookup', () => agents);

const files = vi.hoisted(() => ({
    readFile: vi.fn(async () => ({ content: 'file body' })),
    writeFile: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../files/ipc', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../files/ipc')>()),
    ...files,
}));

import { handleApi, type MobileDataDeps } from '../api';
import {
    _resetAuthForTest,
    _setPinForTest,
    attemptPair,
    initAuth,
    mintGuestSession,
} from '../auth';
import { _resetAuditForTest } from '../audit';
import { _resetBatonForTest, setLocked } from '../baton';
import { GUEST_NOT_GRANTED, GUEST_READ_ONLY, guestMayUseSite } from '../guest-access';
import type { HostAccessPolicy } from '../../host-core/access-policy';

// --- fixture: one shared workspace, one private one ---------------------------

const SHARED = { id: 'ws-shared', project_name: 'Shared App', path: '/w/shared' };
const PRIVATE = { id: 'ws-private', project_name: 'Private Payroll', path: '/w/private' };

const spec = (id: string, workspace_id: string) => ({
    id,
    workspace_id,
    label: id,
    type: 'terminal',
    cwd: '/tmp',
    live_cwd: null,
});

const spies = {
    startProcess: vi.fn(),
    stopProcess: vi.fn(),
    restartProcess: vi.fn(),
    runScheduleNow: vi.fn(),
    createAgentTerminal: vi.fn(() => ({ id: 't-new', scrollback: '', existing: false })),
    killTerminalById: vi.fn(() => true),
    answerPendingQuestion: vi.fn(() => true),
    installUpdate: vi.fn(() => ({ ok: true })),
    checkUpdate: vi.fn(async () => ({ state: 'idle', currentVersion: '1', latestVersion: null, readyToInstall: false })),
    restartAgentTerminal: vi.fn(() => ({ ok: false as const, error: 'x' })),
    createSpecializedAgentTerminal: vi.fn(() => ({ ok: true })),
    agentStart: vi.fn(async () => ({ ok: true })),
    agentStop: vi.fn(() => ({ ok: true })),
    agentList: vi.fn(() => []),
};

function deps(): MobileDataDeps {
    return {
        listWorkspaces: () => [SHARED, PRIVATE],
        workspaceTynnProjectId: (id: string) => (id === SHARED.id ? 'proj-shared' : id === PRIVATE.id ? 'proj-private' : null),
        listTerminalSpecs: () => [spec('t-shared', SHARED.id), spec('t-private', PRIVATE.id)],
        listAllProcesses: () => [
            { id: 'p-shared', kind: 'process', label: 'shared web', command: 'npm run dev', workspace: SHARED.project_name, workspaceId: SHARED.id, status: 'running', autostart: false },
            { id: 'p-private', kind: 'process', label: 'payroll worker', command: 'php artisan', workspace: PRIVATE.project_name, workspaceId: PRIVATE.id, status: 'running', autostart: false },
        ],
        liveTerminalIds: () => ['t-shared', 't-private'],
        startProcess: spies.startProcess,
        stopProcess: spies.stopProcess,
        restartProcess: spies.restartProcess,
        scheduleInfo: () => ({
            'p-shared': { nextAt: 1, description: 'hourly' },
            'p-private': { nextAt: 2, description: 'nightly payroll' },
        }),
        runScheduleNow: spies.runScheduleNow,
        createAgentTerminal: spies.createAgentTerminal,
        createSpecializedAgentTerminal: spies.createSpecializedAgentTerminal,
        restartAgentTerminal: spies.restartAgentTerminal,
        killTerminalById: spies.killTerminalById,
        writeToTerminal: () => true,
        readTerminalOutput: () => ({ data: '', cursor: 0, dropped: false }),
        getScrollback: () => '',
        resize: () => true,
        listPendingQuestions: () => [
            { id: 'q-shared', questions: [], index: 0, workspaceLabel: SHARED.project_name, workspacePath: SHARED.path },
            { id: 'q-private', questions: [], index: 1, workspaceLabel: PRIVATE.project_name, workspacePath: PRIVATE.path },
        ],
        answerPendingQuestion: spies.answerPendingQuestion,
        updateStatus: () => ({ state: 'idle', currentVersion: '1', latestVersion: null, readyToInstall: false }),
        installUpdate: spies.installUpdate,
        checkUpdate: spies.checkUpdate,
        listEnabledSites: async () => [
            { workspaceId: SHARED.id, siteId: 'site-shared', genName: 'shared', hostname: 'shared.gen', scheme: 'http', port: 1 },
            { workspaceId: SHARED.id, siteId: 'site-shared-admin', genName: 'admin', hostname: 'admin.shared.gen', scheme: 'http', port: 2 },
            { workspaceId: PRIVATE.id, siteId: 'site-private', genName: 'payroll', hostname: 'payroll.gen', scheme: 'http', port: 3 },
        ],
        agentRecords: {
            list: spies.agentList,
            roster: () => [],
            adopt: async () => ({}),
            create: async () => ({}),
            start: spies.agentStart,
            stop: spies.agentStop,
            remove: async () => ({}),
            setDefault: () => ({}),
            addRuntime: () => ({}),
            front: () => ({}),
            setAvatar: () => ({}),
        },
    } as unknown as MobileDataDeps;
}

// --- request plumbing (the same fakes the other route suites use) -------------

function fakeRes() {
    let status = 0;
    let body = '';
    const res = {
        writeHead(s: number) {
            status = s;
            return res;
        },
        end(d?: string) {
            if (typeof d === 'string') body = d;
        },
    } as unknown as http.ServerResponse;
    return {
        res,
        get status() {
            return status;
        },
        get body() {
            return body;
        },
        get json() {
            return body ? (JSON.parse(body) as any) : null;
        },
    };
}

function request(method: string, url: string, token: string, body?: unknown): http.IncomingMessage {
    const r = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as http.IncomingMessage;
    Object.assign(r, { method, url, headers: { authorization: `Bearer ${token}` } });
    return r;
}

async function call(token: string, method: string, url: string, body?: unknown) {
    const r = fakeRes();
    const pathname = url.split('?')[0];
    await handleApi(request(method, url, token, body), r.res, pathname, deps(), { ip: '127.0.0.1', ua: 'test' });
    return { status: r.status, json: r.json, body: r.body };
}

const policy = (overrides: Partial<HostAccessPolicy> = {}): HostAccessPolicy => ({
    principalId: 'tynn-user-guest',
    principalType: 'tynn-user',
    transports: ['tynn'],
    capability: 'control',
    workspaceScopes: [`workspace:${SHARED.id}`],
    sitePermissions: { 'site-shared': 'interact' },
    ...overrides,
});

let owner: string;
let guest: string;
let viewer: string;

beforeEach(async () => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    for (const spy of Object.values(spies)) spy.mockClear();
    db.listWorkspaces.mockReturnValue([SHARED, PRIVATE]);
    db.listTerminalSpecs.mockReturnValue([spec('t-shared', SHARED.id), spec('t-private', PRIVATE.id)]);
    db.getTerminalSpec.mockImplementation((id: string) =>
        id === 't-shared' ? spec('t-shared', SHARED.id) : id === 't-private' ? spec('t-private', PRIVATE.id) : undefined,
    );
    for (const fn of [db.createTerminalSpec, db.updateTerminalSpec, db.deleteTerminalSpec, db.reorderTerminalSpecs]) fn.mockClear();
    lists.workspaceOfListItem.mockImplementation((id: string) => (id === 'todo-private' ? PRIVATE.id : SHARED.id));
    lists.resolveUserListItemOnHost.mockClear();
    agents.getWorkspaceAgentById.mockImplementation((id: string) =>
        id === 'agent-private' ? { id, workspace_id: PRIVATE.id } : { id, workspace_id: SHARED.id },
    );
    files.readFile.mockClear();

    initAuth({ userDataDir: null, confirmPair: async () => true });
    _setPinForTest('123456');
    const paired = await attemptPair('123456', { ip: '127.0.0.1', ua: 'test' });
    if (!paired.ok) throw new Error('pair failed');
    owner = paired.token;
    guest = mintGuestSession({ policy: policy(), name: 'Sam Support' }).token;
    viewer = mintGuestSession({
        policy: policy({ principalId: 'tynn-user-viewer', capability: 'readonly', sitePermissions: { 'site-shared': 'browse' } }),
        name: 'Vic Viewer',
    }).token;
});

afterEach(() => {
    setLocked(false);
    _resetAuthForTest();
    _resetBatonForTest();
});

// --- 1. listings are filtered --------------------------------------------------

describe('a guest sees only the workspace they were given', () => {
    const listings: Array<[string, string]> = [
        ['GET', '/api/state'],
        ['GET', '/api/workspaces'],
        ['GET', '/api/terminals'],
        ['GET', '/api/processes'],
        ['GET', '/api/questions'],
        ['GET', '/api/schedules'],
        ['GET', '/api/desktop/workspaces'],
        ['GET', '/api/desktop/terminal-specs'],
    ];

    it.each(listings)('%s %s names nothing from the private workspace', async (method, url) => {
        const res = await call(guest, method, url);

        expect(res.status).toBe(200);
        expect(res.body).not.toMatch(/ws-private|Private Payroll|\/w\/private|t-private|p-private|q-private|nightly payroll/);
    });

    it.each(listings)('%s %s still shows the shared workspace (positive control)', async (method, url) => {
        const res = await call(guest, method, url);

        expect(res.body).toMatch(/ws-shared|Shared App|t-shared|p-shared|q-shared|hourly/);
    });

    it.each(listings)('%s %s is unchanged for the owner\'s own device', async (method, url) => {
        const res = await call(owner, method, url);

        expect(res.status).toBe(200);
        expect(res.body).toMatch(/ws-private|Private Payroll|t-private|p-private|q-private|nightly payroll/);
    });

    it('lists only the sites the grant names, on the shared workspace', async () => {
        const res = await call(guest, 'GET', '/api/sites/enabled');

        expect(res.status).toBe(200);
        expect(res.json.sites.map((s: { siteId: string }) => s.siteId)).toEqual(['site-shared']);
    });

    // genie#687: Tynn writes a scope with the workspace's Tynn project id when it has
    // one, and on a desktop that differs from the host's own workspace id.
    it('reaches the workspace its grant names by Tynn project id, and only that one', async () => {
        const byProject = mintGuestSession({
            policy: policy({ principalId: 'tynn-user-by-project', workspaceScopes: ['workspace:proj-shared'] }),
            name: 'Pat Project',
        }).token;

        const res = await call(byProject, 'GET', '/api/terminals');

        expect(res.status).toBe(200);
        expect(res.body).toMatch(/t-shared/);
        expect(res.body).not.toMatch(/t-private/);
        expect((await call(byProject, 'POST', '/api/process/p-private/stop')).status).toBe(404);
        expect(spies.stopProcess).not.toHaveBeenCalled();
        expect((await call(byProject, 'POST', '/api/process/p-shared/stop')).status).toBe(200);
        const sites = await call(byProject, 'GET', '/api/sites/enabled');
        expect(sites.json.sites.map((s: { siteId: string }) => s.siteId)).toEqual(['site-shared']);
    });

    it('lets the site proxy through to a granted site of a workspace named by project id', () => {
        const byProject = policy({ workspaceScopes: ['workspace:proj-shared'] });

        expect(guestMayUseSite(byProject, deps(), { workspaceId: SHARED.id, siteId: 'site-shared' }, { method: 'GET' })).toBe(true);
        expect(guestMayUseSite(byProject, deps(), { workspaceId: PRIVATE.id, siteId: 'site-private' }, { method: 'GET' })).toBe(false);
    });

    it('reaches nothing with a project id no workspace here is linked to', async () => {
        const stranger = mintGuestSession({
            policy: policy({ principalId: 'tynn-user-elsewhere', workspaceScopes: ['workspace:proj-elsewhere'] }),
            name: 'Elle Elsewhere',
        }).token;

        const res = await call(stranger, 'GET', '/api/terminals');

        expect(res.body).not.toMatch(/t-shared|t-private/);
    });
});

// --- 2. out-of-scope targets are unknown, and nothing runs ---------------------

describe('a guest cannot reach into the private workspace', () => {
    type Case = { name: string; method: string; url: string; body?: unknown; ran: () => unknown[] };
    const outOfScope: Case[] = [
        { name: 'create a terminal', method: 'POST', url: '/api/terminal/create', body: { workspaceId: PRIVATE.id }, ran: () => spies.createAgentTerminal.mock.calls },
        { name: 'open a terminal', method: 'POST', url: '/api/desktop/terminal-open', body: { id: 't-x', workspaceId: PRIVATE.id }, ran: () => spies.createAgentTerminal.mock.calls },
        { name: 'kill a terminal', method: 'POST', url: '/api/terminal/t-private/kill', ran: () => spies.killTerminalById.mock.calls },
        { name: 'stop a process', method: 'POST', url: '/api/process/p-private/stop', ran: () => spies.stopProcess.mock.calls },
        { name: 'run a schedule', method: 'POST', url: '/api/process/p-private/run-now', ran: () => spies.runScheduleNow.mock.calls },
        { name: 'answer a question', method: 'POST', url: '/api/questions/q-private/answer', body: { answers: [] }, ran: () => spies.answerPendingQuestion.mock.calls },
        { name: 'read a file', method: 'POST', url: '/api/files/read', body: { workspacePath: PRIVATE.path, relPath: '.env' }, ran: () => files.readFile.mock.calls },
        { name: 'write a file', method: 'POST', url: '/api/files/write', body: { workspacePath: PRIVATE.path, relPath: 'x', content: 'y' }, ran: () => files.writeFile.mock.calls },
        { name: 'read a terminal spec', method: 'POST', url: '/api/desktop/terminal-spec/get', body: { id: 't-private' }, ran: () => db.getTerminalSpec.mock.calls.filter(([id]) => id === 't-private' && false) },
        { name: 'restart an agent terminal', method: 'POST', url: '/api/desktop/terminal-spec/restart-agent', body: { id: 't-private' }, ran: () => spies.restartAgentTerminal.mock.calls },
        { name: 'remove a terminal spec', method: 'POST', url: '/api/desktop/terminal-spec/remove', body: { id: 't-private' }, ran: () => db.deleteTerminalSpec.mock.calls },
        { name: 'create a terminal spec', method: 'POST', url: '/api/desktop/terminal-spec/create', body: { input: { workspace_id: PRIVATE.id } }, ran: () => db.createTerminalSpec.mock.calls },
        { name: 'create an agent terminal', method: 'POST', url: '/api/desktop/terminal-spec/create-agent', body: { input: { workspace_id: PRIVATE.id, scope: 'self' } }, ran: () => spies.createSpecializedAgentTerminal.mock.calls },
        { name: 'list agents', method: 'POST', url: '/api/desktop/agents/list', body: { workspaceId: PRIVATE.id }, ran: () => spies.agentList.mock.calls },
        { name: 'stop an agent', method: 'POST', url: '/api/desktop/agents/stop', body: { agentId: 'agent-private' }, ran: () => spies.agentStop.mock.calls },
        { name: 'read lists', method: 'GET', url: `/api/desktop/lists/read?workspaceId=${PRIVATE.id}`, ran: () => lists.readWorkspaceLists.mock.calls.filter(([id]) => id === PRIVATE.id) },
        { name: 'resolve a list item', method: 'POST', url: '/api/desktop/lists/resolve', body: { todoId: 'todo-private', action: 'done' }, ran: () => lists.resolveUserListItemOnHost.mock.calls },
    ];

    it.each(outOfScope)('refuses to $name there, as if it did not exist, and runs nothing', async (c) => {
        const res = await call(guest, c.method, c.url, c.body);

        expect(res.status).toBe(404);
        expect(res.body).not.toMatch(/Private Payroll|\/w\/private/);
        expect(c.ran()).toHaveLength(0);
    });

    it('refuses to reorder terminals when any of them is out of scope', async () => {
        const res = await call(guest, 'POST', '/api/desktop/terminal-spec/reorder', { ids: ['t-shared', 't-private'] });

        expect(res.status).toBe(404);
        expect(db.reorderTerminalSpecs).not.toHaveBeenCalled();
    });

    it('refuses to move a terminal spec into the private workspace', async () => {
        const res = await call(guest, 'POST', '/api/desktop/terminal-spec/update', {
            id: 't-shared',
            patch: { workspace_id: PRIVATE.id },
        });

        expect(res.status).toBe(404);
        expect(db.updateTerminalSpec).not.toHaveBeenCalled();
    });

    it('refuses an agent terminal that could message every workspace', async () => {
        const res = await call(guest, 'POST', '/api/desktop/terminal-spec/create-agent', {
            input: { workspace_id: SHARED.id, agent: 'claude', purpose: 'x', scope: 'all' },
        });

        expect(res.status).toBe(403);
        expect(spies.createSpecializedAgentTerminal).not.toHaveBeenCalled();
    });

    it('does the same things in the SHARED workspace (positive control)', async () => {
        expect((await call(guest, 'POST', '/api/terminal/create', { workspaceId: SHARED.id })).status).toBe(200);
        expect(spies.createAgentTerminal).toHaveBeenCalledTimes(1);

        expect((await call(guest, 'POST', '/api/process/p-shared/stop')).status).toBe(200);
        expect(spies.stopProcess).toHaveBeenCalledWith('p-shared');

        expect((await call(guest, 'POST', '/api/files/read', { workspacePath: SHARED.path, relPath: 'README.md' })).status).toBe(200);
        expect(files.readFile).toHaveBeenCalledTimes(1);

        expect((await call(guest, 'POST', '/api/desktop/agents/stop', { agentId: 'agent-shared' })).status).toBe(200);
        expect(spies.agentStop).toHaveBeenCalledWith('agent-shared');
    });
});

// --- 3. host management is refused ---------------------------------------------

describe('a guest cannot manage the host', () => {
    const hostRoutes: Array<[string, string, unknown?]> = [
        ['GET', '/api/desktop/settings'],
        ['POST', '/api/desktop/settings', { patch: { ai_system: 'pwned' } }],
        ['GET', '/api/update/status'],
        ['POST', '/api/update/check'],
        ['POST', '/api/update/install', {}],
        ['GET', '/api/desktop/plugins'],
        ['POST', '/api/desktop/plugins/enable', { id: 'x', enabled: true }],
        ['GET', '/api/desktop/agentinbox/directory'],
        ['POST', '/api/desktop/agentinbox/post', { toAgentId: 'a', text: 'hi' }],
        ['GET', '/api/desktop/tynn/projects'],
        ['GET', '/api/desktop/setup/status'],
        ['POST', '/api/desktop/setup/complete'],
        ['POST', '/api/desktop/session-save'],
        ['POST', '/api/clipboard/image', { dataBase64: 'AAAA' }],
        ['POST', '/api/desktop/dev-server/service', { workspaceId: SHARED.id, req: { action: 'inventory' } }],
        ['GET', '/api/some/route-nobody-classified'],
    ];

    it.each(hostRoutes)('%s %s is not part of a shared session', async (method, url, body) => {
        const res = await call(guest, method, url, body);

        expect(res.status).toBe(403);
        expect(res.json.error).toBe(GUEST_NOT_GRANTED);
        expect(spies.installUpdate).not.toHaveBeenCalled();
        expect(spies.checkUpdate).not.toHaveBeenCalled();
    });

    it('does not let a guest bearer pair a new owner device', async () => {
        const r = fakeRes();
        await handleApi(request('POST', '/api/pair', guest, { pin: '123456' }), r.res, '/api/pair', deps(), {
            ip: '127.0.0.1',
            ua: 'test',
        });

        expect(r.status).toBe(403);
        expect(r.json.token).toBeUndefined();
    });

    it('still lets the owner\'s device manage the host (positive control)', async () => {
        expect((await call(owner, 'GET', '/api/desktop/settings')).status).toBe(200);
        expect((await call(owner, 'POST', '/api/update/install', {})).status).toBe(200);
        expect(spies.installUpdate).toHaveBeenCalledTimes(1);
    });
});

// --- 4. read-only ----------------------------------------------------------------

describe('a read-only guest changes nothing', () => {
    const writes: Array<[string, string, unknown?]> = [
        ['POST', '/api/terminal/create', { workspaceId: SHARED.id }],
        ['POST', '/api/process/p-shared/restart'],
        ['POST', '/api/files/write', { workspacePath: SHARED.path, relPath: 'a', content: 'b' }],
        ['POST', '/api/questions/q-shared/answer', { answers: [] }],
        ['POST', '/api/control/take'],
        ['POST', '/api/desktop/dev-server/site', { workspaceId: SHARED.id, req: { action: 'restart', id: 's' } }],
    ];

    it.each(writes)('%s %s is refused as read-only, in its OWN workspace', async (method, url, body) => {
        const res = await call(viewer, method, url, body);

        expect(res.status).toBe(403);
        expect(res.json.error).toBe(GUEST_READ_ONLY);
        expect(spies.createAgentTerminal).not.toHaveBeenCalled();
        expect(spies.restartProcess).not.toHaveBeenCalled();
        expect(files.writeFile).not.toHaveBeenCalled();
        expect(spies.answerPendingQuestion).not.toHaveBeenCalled();
    });

    it('still reads its workspace (positive control)', async () => {
        expect((await call(viewer, 'POST', '/api/files/read', { workspacePath: SHARED.path, relPath: 'README.md' })).status).toBe(200);
        expect((await call(viewer, 'GET', '/api/terminals')).body).toMatch(/t-shared/);
    });
});

// --- hosting controls (owner decision: control includes start/stop/restart/logs) -

describe('a control guest runs its workspace\'s sites, but does not reconfigure them', () => {
    it.each(['create', 'update', 'remove'])('refuses site %s', async (action) => {
        const res = await call(guest, 'POST', '/api/desktop/dev-server/site', {
            workspaceId: SHARED.id,
            req: { action },
        });

        expect(res.status).toBe(403);
        expect(res.json.error).toBe(GUEST_NOT_GRANTED);
    });

    it('refuses a site action in the private workspace', async () => {
        const res = await call(guest, 'POST', '/api/desktop/dev-server/site', {
            workspaceId: PRIVATE.id,
            req: { action: 'logs', id: 'payroll' },
        });

        expect(res.status).toBe(404);
    });
});

// --- the baton: a guest is never an owner ----------------------------------------

describe('a control guest takes turns, and cannot take control from the desktop', () => {
    it('is refused TAKING control while the desktop holds it', async () => {
        setLocked(true);

        const res = await call(guest, 'POST', '/api/control/take');

        expect(res.status).toBe(403);
    });

    it('claims a free baton by driving (positive control)', async () => {
        const res = await call(guest, 'POST', '/api/terminal/create', { workspaceId: SHARED.id });

        expect(res.status).toBe(200);
    });
});
