import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { CONTROL_METHODS, REMOTE_METHODS, capabilityOf, inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type RemoteMethod, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * A SHARED WORKSPACE REACHES ONLY ITS WORKSPACE (Tynn #688, part 3: the host is the boundary).
 *
 * A Tynn share link or invite to ONE workspace admits a guest over the relay as `{ isOwner: false, workspaceId }`. Its
 * window must not show the workstation, and — what actually holds — the host must not answer it about the workstation.
 * Every bridge method a relay principal can name is in ONE table below, by family, with the arguments that stay inside
 * the shared workspace and the arguments that reach outside it. For each:
 *  - a CONTROL guest of `tynn` (holding the baton): `allow` reaches the host; `refuse` is a refusal frame and the host is
 *    never asked; every outside argument list is refused, the host never asked;
 *  - a READ-ONLY guest of `tynn`: only an allowed READ reaches the host;
 *  - the OWNER over the same relay (positive control): every call the guest is refused reaches the host — so a refusal
 *    measures the principal, not a method the host could not answer anyway. Host-only and local methods are refused to
 *    anyone over the relay and say so.
 * A method added to the wire without a row here fails the exhaustiveness test: it must be classified before it ships.
 */

const A = 'agent_a'; // in `tynn`, the shared workspace
const B = 'agent_b'; // in `fancy`, which is not shared
const STAGED = Symbol('a file staged on this connection');

const snapshot = {
    agents: [
        { id: A, name: 'atlas', workspaceId: 'tynn' },
        { id: B, name: 'bolt', workspaceId: 'fancy' },
    ],
    osAgent: { id: 'genie', name: 'Genie', workspaceId: '' },
    workspaces: [{ id: 'tynn', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }],
    hibernatedWorkspaces: [{ id: 'sleepy', path: '/w/sleepy', name: 'sleepy', asleep: true }],
    deckItems: [{ id: 'q_1', workspaceId: 'tynn' }, { id: 'q_2', workspaceId: 'fancy' }, { id: 'q_os', workspaceId: null }],
    signals: { flowsRunning: 3, uncollectedMail: 7, githubBlocked: true, osAgentWorking: true },
    workstation: { name: 'alphar', healthy: true },
    safeMode: { on: true, reason: 'the host restarted 3 times' },
    hangNotice: { at: 1, why: 'a window hung' },
    rendererNotice: { at: 2, why: 'renderer gone' },
};

type Guest = 'allow' | 'refuse' | 'answer' | 'host-only';
interface Row { readonly method: RemoteMethod; readonly in: readonly unknown[]; readonly out?: readonly (readonly unknown[])[]; readonly guest: Guest }

const row = (method: RemoteMethod, guest: Guest, args: readonly unknown[] = [], out?: readonly (readonly unknown[])[]): Row => ({ method, guest, in: args, ...(out ? { out } : {}) });

/** Every non-local bridge method, by family. */
const FAMILIES: Record<string, readonly Row[]> = {
    'the estate snapshot': [row('snapshot', 'allow')],
    agents: [
        row('agentDetail', 'allow', [A], [[B]]),
        row('openAgent', 'allow', [A], [[B]]),
        row('stopAgent', 'allow', [A], [[B]]),
        row('cancelTurn', 'allow', [A, 'stop'], [[B, 'stop']]),
        row('resumeLimit', 'allow', [A], [[B]]),
        row('providerLogin', 'host-only', [A]),
        row('prompt', 'allow', [A, 'hi'], [[B, 'hi']]),
        row('resolvePrompt', 'allow', [A, 'd1', 'send'], [[B, 'd1', 'send']]),
        row('addAgent', 'allow', ['tynn', { name: 'x' }], [['fancy', { name: 'x' }]]),
        row('answerApproval', 'allow', [A, 'opt'], [[B, 'opt']]),
        row('agents.restart', 'allow', [A, 'graceful'], [[B, 'graceful']]),
        row('agents.previewDelete', 'allow', [A, 'unmount'], [[B, 'unmount']]),
        row('agents.delete', 'allow', [A, 'unmount'], [[B, 'unmount']]),
        row('agents.switchDriver', 'allow', [A, 'codex'], [[B, 'codex']]),
        row('agents.setBudget', 'allow', [A, 1], [[B, 1]]),
        row('agents.setMode', 'allow', [A, 'manual'], [[B, 'manual']]),
        row('agents.setAccessScope', 'allow', [A, 'self'], [[B, 'self']]),
        // Who may message it: another workspace's agent is not this link's to name.
        row('agents.setAccessAgents', 'allow', [A, [A]], [[B, []], [A, [B]], [A, [A, B]]]),
        row('agents.setAutoApprove', 'allow', [A, true], [[B, true]]),
        row('agents.setManageTabs', 'allow', [A, true], [[B, true]]),
        row('agents.setDrivePages', 'allow', [A, true], [[B, true]]),
        row('agents.setMcpServer', 'allow', [A, 'genie', false], [[B, 'genie', false]]),
        row('agents.setIssueWatch', 'allow', [A, {}], [[B, {}]]),
        row('agents.setPermissions', 'allow', [A, 'ask'], [[B, 'ask']]),
        row('agents.setModel', 'allow', [A, null], [[B, null]]),
        row('agents.models', 'allow', [A], [[B]]),
        row('agents.diagnose', 'allow', [A], [[B]]),
        row('agents.toolOutput', 'allow', [A, 't1'], [[B, 't1']]),
        row('agents.attachment', 'allow', [A, 'i1'], [[B, 'i1']]),
        row('activity', 'allow', ['tynn'], [['fancy']]),
        row('takeOver', 'refuse', [A]),
    ],
    'adding to the host (the workstation’s roster)': [
        row('workspaces.previewAdd', 'refuse', ['/w/tynn']),
        row('workspaces.confirmAdd', 'refuse', ['/w/tynn']),
        row('workspaces.create', 'refuse', ['x', '/w']),
        row('workspaces.previewAddFromGit', 'refuse', ['u', '/w']),
        row('workspaces.confirmAddFromGit', 'refuse', ['u', '/w']),
        row('workspaces.readSource', 'refuse', ['/w/tynn']),
        row('workspaces.stageFromGit', 'refuse', ['u']),
        row('workspaces.registerExisting', 'refuse', ['/w/tynn']),
        row('workspaces.buildEnvelope', 'refuse', [{}, {}]),
        row('workspaces.discardStaged', 'refuse', ['/s']),
        row('workspaces.githubRepos', 'refuse'),
        row('workspaces.tynnProjects', 'refuse'),
        row('workspaces.tynnOwnerOptions', 'refuse'),
        row('workspaces.createTynnProject', 'refuse', [{}]),
        row('workspaces.importedAgents', 'refuse', ['tynn']),
        row('workspaces.adoptAgent', 'refuse', ['tynn', 'x']),
        row('workspaces.previewAddFromTynn', 'refuse', ['p', '/w']),
        row('workspaces.confirmAddFromTynn', 'refuse', ['/w', 'p']),
        row('addWorkspace', 'host-only'),
        // Hibernating, waking or removing a workspace changes the workstation's roster: its own workspace included.
        row('workspaces.hibernate', 'refuse', ['tynn']),
        row('workspaces.wake', 'refuse', ['tynn']),
        row('workspaces.remove', 'refuse', ['tynn']),
        // A workspace that governs others reaches them: never set from a link to one workspace.
        row('workspaces.setGoverns', 'refuse', ['tynn', []]),
    ],
    'the shared workspace itself': [
        row('workspaces.listRepos', 'allow', ['tynn'], [['fancy']]),
        row('workspaces.addRepo', 'allow', ['tynn', { name: 'r', path: 'r' }], [['fancy', { name: 'r', path: 'r' }]]),
        row('workspaces.removeRepo', 'allow', ['tynn', 'r'], [['fancy', 'r']]),
        row('workspaces.removeRepoLock', 'allow', ['tynn', 'r'], [['fancy', 'r']]),
        row('workspaces.locateRepo', 'allow', ['tynn', 'r', '/w/tynn/r'], [['fancy', 'r', '/w/fancy/r']]),
        row('workspaces.commitsSince', 'allow', ['tynn', 0], [['fancy', 0]]),
        row('workspaces.settings', 'allow', ['tynn'], [['fancy']]),
        row('workspaces.setSetting', 'allow', ['tynn', 'agent_cap', '2'], [['fancy', 'agent_cap', '2']]),
        row('workspaces.resetSetting', 'allow', ['tynn', 'agent_cap'], [['fancy', 'agent_cap']]),
        row('workspaces.setDefaultAgent', 'allow', ['tynn', A], [['fancy', A], ['tynn', B]]),
        row('workspaces.setColor', 'allow', ['tynn', '#fff'], [['fancy', '#fff']]),
        row('workspaces.setMcpServer', 'allow', ['tynn', 'genie', false], [['fancy', 'genie', false]]),
    ],
    'tynn (the host owner’s Tynn pairing)': [
        row('workspaces.tynnBoard', 'refuse', ['tynn', {}]),
        row('workspaces.tynnBoardAction', 'refuse', ['tynn', {}]),
        row('workspaces.tynnPage', 'refuse', ['tynn', 'home', {}]),
        row('workspaces.tynnIssues', 'refuse', ['tynn', {}]),
        row('workspaces.tynnIssueAction', 'refuse', ['tynn', {}]),
        row('workspaces.tynnPageAction', 'refuse', ['tynn', {}]),
        row('tynnNetwork.shares.list', 'refuse', [null]),
        row('tynnNetwork.shares.mint', 'refuse', [{ workspaceId: 'tynn' }]),
        row('tynnNetwork.shares.revoke', 'refuse', ['l1']),
    ],
    terminals: [
        row('terminals.open', 'allow', ['tynn', {}], [['fancy', {}]]),
        row('terminals.list', 'allow', ['tynn'], [['fancy']]),
        row('terminals.attach', 'allow', ['tynn', 'term_t'], [['fancy', 'term_f']]),
        // By terminal id: another workspace's terminal, or one the host cannot place, is not this link's.
        row('terminals.write', 'allow', ['term_t', 'ls'], [['term_f', 'ls'], ['term_unknown', 'ls']]),
        row('terminals.resize', 'allow', ['term_t', 80, 24], [['term_f', 80, 24], ['term_unknown', 80, 24]]),
        row('terminals.close', 'allow', ['term_t'], [['term_f'], ['term_unknown']]),
    ],
    'files and the host’s disk': [
        row('files.children', 'allow', ['tynn', ''], [['fancy', '']]),
        row('files.open', 'allow', ['tynn', 'a.txt'], [['fancy', 'a.txt']]),
        row('files.readMedia', 'allow', ['tynn', 'a.png'], [['fancy', 'a.png']]),
        row('files.upload', 'allow', ['tynn', '', STAGED], [['fancy', '', STAGED]]),
        row('host.listDir', 'allow', ['/w/tynn'], [['/w/fancy'], ['/w'], ['/w/tynn/../fancy']]),
        row('host.home', 'answer'),
        row('host.mkdir', 'refuse', ['/w/tynn', 'x']),
    ],
    'the workstation’s features (settings, processes, sites, services, flows, hosting, toolchain)': [
        row('features.snapshot', 'refuse'),
        row('features.act', 'refuse', [{ kind: 'settings.set', key: 'theme', value: 'dark' }]),
        row('features.setBrowserBounds', 'host-only', [{}]),
    ],
    updates: [
        row('updates.state', 'refuse'),
        row('updates.check', 'refuse'),
        row('updates.download', 'refuse'),
        row('updates.install', 'refuse'),
        row('updates.forceDrain', 'refuse'),
    ],
    inbox: [
        // A file to one of ITS agents, by id; another workspace's agent, or a name the host would resolve anywhere, is not.
        row('inbox.sendFile', 'allow', [A, 'hi', 'a.txt', 'aGk='], [[B, 'hi', 'a.txt', 'aGk='], ['bolt@fancy', 'hi', 'a.txt', 'aGk='], ['bolt', 'hi', 'a.txt', 'aGk=']]),
    ],
};

const ROWS = Object.values(FAMILIES).flat();
const LOCAL = REMOTE_METHODS.filter((m) => capabilityOf(m) === 'local');

function fakeApi() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const listeners = new Set<(channel: string, payload: unknown) => void>();
    const api: HostApi = {
        invoke: async (method, args) => {
            calls.push({ method, args });
            if (method === 'snapshot') return snapshot;
            if (method === 'features.snapshot') return { settings: { values: { theme: 'dark' } }, processes: [{ workspaceId: 'fancy', name: 'queue' }], remote: {} };
            return { ok: true };
        },
        onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        workspaceOfAgent: (id) => snapshot.agents.find((a) => a.id === id)?.workspaceId ?? null,
        workspaceOfTerminal: (id) => ({ term_t: 'tynn', term_f: 'fancy' } as Record<string, string>)[id] ?? null,
        workspacePaths: () => ({ tynn: '/w/tynn', fancy: '/w/fancy' }),
    };
    return { api, calls, emit: (channel: string, payload: unknown) => { for (const l of listeners) l(channel, payload); } };
}

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    const call = async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next() as Promise<Extract<WireMessage, { kind: 'result' }>>; };
    return { call, next, send: (frame: unknown) => t.send(JSON.stringify(frame)) };
}

let dir: string;
let devices: DeviceStore;
let api: ReturnType<typeof fakeApi>;
let connectRelay: (who: PreAuth) => ReturnType<typeof client>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-share-scope-'));
    api = fakeApi();
    devices = await DeviceStore.open(dir, { now: () => 1_000_000, random: () => 'tok' });
    const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
    new RemoteHost({
        now: () => 1_000_000, confirm: allowEveryPairing, api: api.api, hostName: 'alphar', baton: new Baton(),
        pins: new PairingPins({ now: () => 1_000_000 }), devices,
        transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } },
    });
    connectRelay = (who) => { const pair = inMemoryPair(); for (const cb of connections) cb({ ...pair.server, remoteAddress: 'relay:wren', preAuth: who }); return client(pair.client); };
});

afterEach(async () => {
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

const WORKSPACE_GUEST: PreAuth = { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false };
const READONLY_GUEST: PreAuth = { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: true };
const OWNER: PreAuth = { label: 'glenn', isOwner: true, workspaceId: null, readonly: false };

async function admitted(who: PreAuth, drive = true) {
    const c = connectRelay(who);
    c.send({ kind: 'hello', auth: { kind: 'relay' }, label: who.label });
    const welcome = await c.next();
    expect(welcome).toMatchObject({ kind: 'welcome', isOwner: who.isOwner, workspaceId: who.workspaceId });
    if (drive && !who.readonly) expect(await c.call('baton.take')).toMatchObject({ ok: true });
    return { c, welcome };
}

/** Call with `args`, a STAGED placeholder replaced by a file staged on this connection first (a writer only). */
async function callWith(c: ReturnType<typeof client>, who: PreAuth, method: string, args: readonly unknown[]) {
    const real: unknown[] = [];
    for (const a of args) {
        if (a !== STAGED) { real.push(a); continue; }
        if (who.readonly) { real.push({ staged: 'none' }); continue; }
        const begun = await c.call('upload.begin', { name: 'a.txt', size: 1 });
        const id = (begun as { value: { id: string } }).value.id;
        expect(await c.call('upload.chunk', id, 0, Buffer.from('x').toString('base64'))).toMatchObject({ ok: true });
        real.push({ staged: id });
    }
    return c.call(method, ...real);
}

const asked = (method: string) => api.calls.filter((x) => x.method === method).length;

function expectRefused(result: Extract<WireMessage, { kind: 'result' }>, method: string) {
    expect(result).toMatchObject({ kind: 'result', ok: false });
    expect(typeof (result as { reason?: unknown }).reason).toBe('string');
    expect((result as { reason: string }).reason.length).toBeGreaterThan(0);
    expect(asked(method), `${method} must be refused BEFORE the host is asked`).toBe(0);
}

function expectReached(result: Extract<WireMessage, { kind: 'result' }>, method: string) {
    expect(result, `${method} should have been answered`).toMatchObject({ kind: 'result', ok: true });
    expect(asked(method), `${method} should have reached the host`).toBe(1);
}

describe('every bridge method a relay principal can name is classified here (Tynn #688)', () => {
    it('no method is missing from the table, and none is listed twice', () => {
        const listed = ROWS.map((r) => r.method);
        expect(new Set(listed).size).toBe(listed.length);
        const unclassified = REMOTE_METHODS.filter((m) => !listed.includes(m) && !LOCAL.includes(m));
        expect(unclassified).toEqual([]);
    });
});

for (const [family, rows] of Object.entries(FAMILIES)) {
    describe(`${family}: a workspace guest (control), a read-only guest, and the owner (positive control)`, () => {
        for (const r of rows) {
            const readOk = (r.guest === 'allow' || r.guest === 'answer') && capabilityOf(r.method) === 'read';

            it(`${r.method}: workspace guest ${r.guest === 'answer' ? 'is answered by the host itself' : r.guest === 'allow' ? 'reaches the host' : 'is refused'}`, async () => {
                const { c } = await admitted(WORKSPACE_GUEST);
                const result = await callWith(c, WORKSPACE_GUEST, r.method, r.in);
                if (r.guest === 'allow') expectReached(result, r.method);
                else if (r.guest === 'answer') { expect(result).toMatchObject({ ok: true, value: '/w/tynn' }); expect(asked(r.method)).toBe(0); }
                else expectRefused(result, r.method);
            });

            for (const out of r.out ?? []) {
                it(`${r.method}(${JSON.stringify(out.map((a) => (a === STAGED ? '<staged>' : a)))}): outside the shared workspace — refused to the control guest and the read-only guest`, async () => {
                    const g = await admitted(WORKSPACE_GUEST);
                    expectRefused(await callWith(g.c, WORKSPACE_GUEST, r.method, out), r.method);
                    const ro = await admitted(READONLY_GUEST);
                    expectRefused(await callWith(ro.c, READONLY_GUEST, r.method, out), r.method);
                });
            }

            it(`${r.method}: read-only guest ${readOk ? 'may read it' : 'is refused'}`, async () => {
                const { c } = await admitted(READONLY_GUEST);
                const result = await callWith(c, READONLY_GUEST, r.method, r.in);
                if (readOk && r.guest === 'answer') expect(result).toMatchObject({ ok: true, value: '/w/tynn' });
                else if (readOk) expectReached(result, r.method);
                else expectRefused(result, r.method);
            });

            it(`${r.method}: the owner over the same relay ${r.guest === 'host-only' ? 'is refused too (it happens on the host’s own screen)' : 'reaches the host (CONTROL)'}`, async () => {
                const { c } = await admitted(OWNER);
                const result = await callWith(c, OWNER, r.method, r.in);
                if (r.guest === 'host-only') expectRefused(result, r.method);
                else expectReached(result, r.method);
            });
        }
    });
}

describe('local methods are refused to every relay principal, the owner included', () => {
    for (const method of LOCAL) {
        it(`${method}`, async () => {
            for (const who of [WORKSPACE_GUEST, READONLY_GUEST, OWNER]) {
                const { c } = await admitted(who, false);
                expectRefused(await c.call(method), method);
            }
        });
    }
});

describe('connection controls for a workspace principal', () => {
    const LOCAL_CONTROLS = CONTROL_METHODS.filter((m) => m.startsWith('blob.') || m.startsWith('localUpload.') || m.startsWith('page.') || m.startsWith('files.') || m.startsWith('tynn.') || m.startsWith('activity.') || m === 'content.release');

    it('every control is classified: local ones are refused to all relay principals', async () => {
        const handled = ['baton.take', 'baton.release', 'baton.status', 'baton.watch', 'host.lock', 'host.unlock', 'agent.watch', 'agent.unwatch', 'upload.begin', 'upload.chunk', 'upload.abort'];
        expect(CONTROL_METHODS.filter((m) => !handled.includes(m) && !LOCAL_CONTROLS.includes(m))).toEqual([]);
        for (const who of [WORKSPACE_GUEST, READONLY_GUEST, OWNER]) {
            const { c } = await admitted(who, false);
            for (const m of LOCAL_CONTROLS) expect(await c.call(m, 'v1'), m).toMatchObject({ ok: false });
        }
    });

    it('the host’s lock is the owner’s; a guest’s watch reaches only its own agents', async () => {
        const g = await admitted(WORKSPACE_GUEST);
        expect(await g.c.call('host.lock')).toMatchObject({ ok: false });
        expect(await g.c.call('host.unlock')).toMatchObject({ ok: false });
        expect(await g.c.call('agent.watch', B)).toMatchObject({ ok: false, reason: expect.stringContaining('not in the workspace this link shares') });
        expect(asked('agentDetail')).toBe(0);
        expect(await g.c.call('agent.watch', A)).toMatchObject({ ok: true });
        const ro = await admitted(READONLY_GUEST);
        expect(await ro.c.call('baton.take')).toMatchObject({ ok: false });
        expect(await ro.c.call('upload.begin', { name: 'a.txt', size: 1 })).toMatchObject({ ok: false });
        expect(await ro.c.call('agent.watch', B)).toMatchObject({ ok: false });
    });
});

describe('what a workspace guest is told it is, and what it sees of the estate', () => {
    it('the welcome says read-only, so the window can drop every send and act control (the host decides it, never the client)', async () => {
        expect((await admitted(READONLY_GUEST, false)).welcome).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId: 'tynn', readonly: true });
        expect((await admitted(WORKSPACE_GUEST, false)).welcome).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId: 'tynn', readonly: false });
        expect((await admitted(OWNER, false)).welcome).toMatchObject({ kind: 'welcome', isOwner: true, workspaceId: null, readonly: false });
    });

    const WORKSTATION_ONLY = ['osAgent', 'safeMode', 'hangNotice', 'rendererNotice'];
    function expectWorkspaceOnly(value: Record<string, unknown>) {
        expect(value.agents).toEqual([snapshot.agents[0]]);
        expect(value.workspaces).toEqual([snapshot.workspaces[0]]);
        expect(value.hibernatedWorkspaces).toEqual([]);
        expect(value.deckItems).toEqual([snapshot.deckItems[0]]);
        // The workstation's own counts (every workspace's flows and mail, its GitHub, its Genie agent) are not this link's.
        expect(value.signals).toEqual({ flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false });
        for (const key of WORKSTATION_ONLY) expect(value[key] ?? null, key).toBeNull();
    }

    it('the snapshot call: only its workspace — no Genie OS agent, no workstation signals, no host notices', async () => {
        const { c } = await admitted(WORKSPACE_GUEST);
        const result = await c.call('snapshot');
        expect(result).toMatchObject({ ok: true });
        expectWorkspaceOnly((result as { value: Record<string, unknown> }).value);
    });

    it('the snapshot push: the same; the owner still receives every field (CONTROL)', async () => {
        const g = await admitted(WORKSPACE_GUEST, false);
        const o = await admitted(OWNER, false);
        api.emit('snapshot', snapshot);
        const owner = await o.c.next();
        expect(owner).toMatchObject({ kind: 'event', channel: 'snapshot', payload: { osAgent: snapshot.osAgent, signals: snapshot.signals, safeMode: snapshot.safeMode } });
        const guest = await g.c.next();
        expect(guest).toMatchObject({ kind: 'event', channel: 'snapshot' });
        expectWorkspaceOnly((guest as { payload: Record<string, unknown> }).payload);
    });
});
