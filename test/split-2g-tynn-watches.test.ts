import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolDefinition, type JsonObject } from '@particle-academy/prism-mcp';
import { DURABLE_CALLBACKS, ENGINE_METHODS, isEngineMethod } from '../src/core/engine-protocol.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { parseIssueWatchEntry } from '../src/core/issue-watch.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { createFlowRunner } from '../src/main/flow-runner.js';
import type { FlowRecord } from '../src/main/flow-store.js';
import { FlowCallers, createFlowToolCaller, ensureFlowToolKinds } from '../src/main/flow-tools.js';
import { InboxStore } from '../src/main/inbox-store.js';
import type { IssueWatchDump, IssueWatchHostEvent } from '../src/main/issue-watch-host.js';
import { HOST_NATIVE_TOOLS, WINDOW_ACTIONS, hostRegistrations, runsInWindow, windowClosedRefusal } from '../src/main/mcp-host-tools.js';
import { genieTools, type Caller, type Registration } from '../src/main/mcp-tools.js';

/*
 * CLIENT/HOST SPLIT STEP 2g, THE TYNN FAMILY (Tynn #934 task #1474; the last `move:2g` rows of #913). What main still asked
 * of its engine link for Tynn:
 *  - the live board, Issues and Features watches (nine rows). They were DEAD: they fed three doors and `emitTynn`, read
 *    only by main's `tynnWatchPort`, which nothing reads. The Tynn tab's `tynn.watch` is genie-host's own since 2d-3b
 *    (host-local-watches.ts), for this machine's windows and every other client, under its `tynn.watch` scope;
 *  - `issueWatch`, the replica of genie-host's IssueWatch. Its panels and repo switch were dead in main too (genie-host's
 *    feature machine has them). Two readers were live: the `checkIssues` tool, which genie-host forwarded to the window,
 *    and the sound of a batch. `checkIssues` is genie-host's own tool now, read from its IssueWatch with no window; the
 *    sound is a tool signal, like mail's and the things'.
 * EACH DEAD USE HAS ITS PROOF FIRST: a test of the code as it was, saying why nothing can reach it; it holds before the
 * deletion and after it. The deletion's own tests follow, end to end: main, the engine client, the engine server, the
 * engine methods, genie-host's wiring and the inventory, which ends with no `move:` row.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const main = code(src('src/main/main.ts'));
const client = code(src('src/main/session-engine-client.ts'));
const server = code(src('src/main/session-engine-server.ts'));
const host = code(src('src/main/genie-host.ts'));
/** Every file of src/main and src/core (not the tests), as code. */
const sources = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const dir of ['src/main', 'src/core']) for (const name of readdirSync(resolve(root, dir))) if (name.endsWith('.ts')) out.set(`${dir}/${name}`, code(src(`${dir}/${name}`)));
    return out;
};
const filesWith = (pattern: RegExp): string[] => [...sources()].filter(([, text]) => pattern.test(text)).map(([file]) => file).sort();
/** The lines of main that name `name`, trimmed. */
const linesOf = (name: string): string[] => [...main.matchAll(new RegExp(`^.*\\b${name}\\b.*$`, 'gm'))].map((m) => m[0].trim());

const THE_ROWS = ['issueWatch', 'onTynnBoardEvent', 'onTynnFeaturesEvent', 'onTynnIssuesEvent', 'tynnBoardUnwatch', 'tynnBoardWatch', 'tynnFeaturesUnwatch', 'tynnFeaturesWatch', 'tynnIssuesUnwatch', 'tynnIssuesWatch'];
const hostTools = () => import('../src/main/issue-watch-tools.js');
const signals = () => import('../src/core/issue-watch-signal.js');

describe('PROOF: nothing in the window follows a Tynn page over the engine link', () => {
    it('main’s `tynnWatchPort` is read by nothing: at most its own declaration names it, in main and nowhere else', () => {
        const uses = linesOf('tynnWatchPort');
        expect(uses.length).toBeLessThanOrEqual(1);
        for (const line of uses) expect(line).toMatch(/^const tynnWatchPort: TynnWatchPort = \{$/);
        expect(filesWith(/\btynnWatchPort\b/).filter((f) => f !== 'src/main/main.ts')).toEqual([]);
        // CONTROL: the scan finds a name main does read.
        expect(linesOf('ownProtocol').length).toBeGreaterThan(1);
    });

    it('the three doors, `tynnLive` and `emitTynn` are read only on the way to that port: a declaration, the engine wiring, or the port’s own body', () => {
        const ALLOWED = /^(let tynn(Board|Issues|Features)Door: |const tynnLive = |const emitTynn = |const tynnDoorOf = |tynn(Board|Issues|Features)Door = \{ watch: |engineClient\.onTynn(Board|Issues|Features)Event\(|const door = tynnDoorOf\(kind\);|unwatch: \(kind, viewId\) => \{ tynnDoorOf\(kind\)\?\.unwatch\(viewId\); \},|subscribe: \(listener\) => \{ tynnLive\.add\(listener\); )/;
        for (const name of ['tynnBoardDoor', 'tynnIssuesDoor', 'tynnFeaturesDoor', 'tynnLive', 'emitTynn', 'tynnDoorOf']) for (const line of linesOf(name)) expect(line, name).toMatch(ALLOWED);
        // CONTROL: a read anywhere else would not pass.
        expect(ALLOWED.test('tynnWatch: tynnWatchPort,')).toBe(false);
        expect(ALLOWED.test('void tynnBoardDoor?.watch(viewId, workspaceId);')).toBe(false);
    });

    it('the Tynn tab’s watch is genie-host’s own, under its own owner, said over the protocol to the connection that watches', () => {
        expect(host).toMatch(/const hostTynnWatches = hostTynnWatch\(\{ hubs: \{ board: tynnBoard, issues: tynnIssues, features: tynnFeatures \} \}\);/);
        expect(host).toMatch(/tynnWatch: hostTynnWatches\.port \},/);
        expect(code(src('src/main/host-local-watches.ts'))).toMatch(/watch: async \(kind, viewId, workspaceId\) => sources\.hubs\[kind\]\.watch\(HOST_LOCAL_OWNER, viewId, workspaceId\),/);
        expect(code(src('src/main/remote-host.ts'))).toMatch(/case 'tynn\.watch':/);
    });
});

describe('PROOF: the window shows no IssueWatch panel and switches no repo', () => {
    it('main’s `issueWatchPanels` and `issueWatchSetRepoFor` are called by nothing: at most their own declaration names each', () => {
        for (const name of ['issueWatchPanels', 'issueWatchSetRepoFor']) {
            const uses = linesOf(name);
            expect(uses.length, name).toBeLessThanOrEqual(1);
            for (const line of uses) expect(line, name).toMatch(new RegExp(`^(async )?function ${name}\\(`));
        }
    });

    it('the panel and the repo switch are genie-host’s feature machine’s, on its own IssueWatch', () => {
        expect(host).toMatch(/issueWatch: \(\) => featureIssueWatch\.panels\(hostRegistry\.listWorkspaces\(\), workspaceTynnProject, Date\.now\(\)\),/);
        expect(host).toMatch(/issueWatchSetRepo: \(id, owner, repo, change\) => issueWatch\.call\('setRepo', \[id, owner, repo, change\]\)/);
        expect(code(src('src/main/feature-machine.ts'))).toMatch(/issueWatch: ports\.issueWatch \? ports\.issueWatch\(\) : null,/);
    });
});

describe('the Tynn uses left main', () => {
    it('main makes none of the ten uses of its engine client', () => {
        const USES = new RegExp(`[.](${THE_ROWS.join('|')})[(]`);
        expect(main).not.toMatch(USES);
        // CONTROL: the pattern finds each use as main wrote it, and main still uses its engine link for the link's own.
        expect(USES.test('issueWatchNow = engineClient.issueWatch();')).toBe(true);
        expect(USES.test("engineClient.onTynnFeaturesEvent((event) => { emitTynn('features', event.workspaceId, event.signal); });")).toBe(true);
        expect(main).toMatch(/engineLink\.spawnLink\('processes'\)/);
    });

    it('main keeps no Tynn door, no watch port, no IssueWatch replica and reads no workspace’s Tynn project', () => {
        expect(main).not.toMatch(/tynn(Board|Issues|Features)Door|tynnWatchPort|tynnLive|emitTynn|tynnDoorOf|TynnWatch(Port|Event|Kind)/);
        expect(main).not.toMatch(/issueWatchNow|IssueWatchReplica|issueWatchPanels|issueWatchSetRepoFor|issueWatchRefreshFor|issueWatchSummaryFor|tynnProjectFor|tynnProjectIdOf/);
        expect(main).not.toMatch(/IssueWatch(Summary|PanelView|RefreshAnswer)/);
    });

    it('main gives its tools no IssueWatch: `checkIssues` never runs in the window', () => {
        const at = main.indexOf('const registrations = withActionSignal(allGenieTools(genieToolDeps({');
        expect(at).toBeGreaterThan(-1);
        const deps = main.slice(at, main.indexOf('windowToolRun = windowToolRunner(', at));
        expect(deps.length).toBeGreaterThan(200);
        expect(deps).not.toMatch(/issueWatch/);
        // CONTROL: the slice is the tools' wiring.
        expect(deps).toMatch(/thumbsUp: \(caller, reason\) =>/);
    });
});

describe('the engine link carries no Tynn watch and no IssueWatch any more', () => {
    const GONE_METHODS = ['engine.issueWatch', 'engine.tynnBoardWatch', 'engine.tynnBoardUnwatch', 'engine.tynnIssuesWatch', 'engine.tynnIssuesUnwatch', 'engine.tynnFeaturesWatch', 'engine.tynnFeaturesUnwatch'];
    const GONE_EVENTS = ['issueWatch.dump', 'issueWatch.event', 'tynnBoard.event', 'tynnIssues.event', 'tynnFeatures.event'];

    it('none of their methods is an engine method: a frame naming one does not parse', () => {
        for (const method of GONE_METHODS) {
            expect(ENGINE_METHODS as readonly string[], method).not.toContain(method);
            expect(isEngineMethod(method), method).toBe(false);
        }
        // CONTROL: a method of the link's own stays.
        expect(isEngineMethod('engine.spawn')).toBe(true);
    });

    it('the server answers none of them and says none of their events; the client has no member for them', () => {
        for (const name of [...GONE_METHODS, ...GONE_EVENTS]) {
            expect(server.includes(`'${name}'`), `server: ${name}`).toBe(false);
            expect(client.includes(`'${name}'`), `client: ${name}`).toBe(false);
        }
        for (const member of THE_ROWS) expect(client, member).not.toMatch(new RegExp(`^\\s{4}(async\\s+)?${member}\\(`, 'm'));
        expect(client).not.toMatch(/#(board|issues|features)(Views|Listeners)|#issueWatch|IssueWatchReplica|TynnBoardHubEvent/);
        expect(server).not.toMatch(/tynn(Board|Issues|Features)Event\(|#options\.(issueWatch|tynnBoard|tynnIssues|tynnFeatures)\b|readonly (issueWatch|tynnBoard|tynnIssues|tynnFeatures)\?:/);
        // CONTROL: members and options that stay are found by the same patterns.
        expect(client).toMatch(/^\s{4}spawnLink\(/m);
        expect(server).toMatch(/#options\.tynnPages\b/);
    });

    it('genie-host hands its engine server no IssueWatch and no Tynn hub, and its three hubs say their events to its own owner only', () => {
        const at = host.indexOf('new SessionEngineServer({');
        expect(at).toBeGreaterThan(-1);
        const options = host.slice(at, host.indexOf('engineRef = engine;', at));
        expect(options.length).toBeGreaterThan(200);
        expect(options).not.toMatch(/^\s*(issueWatch|tynnBoard|tynnIssues|tynnFeatures),$/m);
        // CONTROL: the slice is the server's options.
        expect(options).toMatch(/^\s*tynnPages: \{ read: readHostTynnPage \},$/m);
        expect(host).not.toMatch(/engineRef\?\.tynn(Board|Issues|Features)Event|ownerRoute/);
        for (const kind of ['board', 'issues', 'features']) expect(host).toContain(`send: (owner, event) => { if (owner === HOST_LOCAL_OWNER) hostTynnWatches.deliver('${kind}', event); },`);
        expect(filesWith(/\bownerRoute\b/)).toEqual([]);
    });
});

describe('the window’s engine inventory', () => {
    it('has no row for IssueWatch or a Tynn watch, and nothing is left to move: no `move:` row at all', () => {
        const rows = new Map(WINDOW_ENGINE_INVENTORY);
        for (const use of THE_ROWS) expect(rows.has(use), use).toBe(false);
        expect(WINDOW_ENGINE_INVENTORY.filter(([, destination]) => destination.startsWith('move:'))).toEqual([]);
        // CONTROL: the rows that stay are read the same way.
        expect(rows.get('welcome')).toBe('link');
        expect(rows.get('browserCall')).toBe('window:feature-effect');
    });
});

/* ---------- checkIssues is genie-host's own tool ---------- */

const item = (kind: string, n: number) => ({ kind, key: `acme/app:${kind}:${n}`, number: n, title: `t${n}`, url: `https://github.com/acme/app/${n}`, updatedAt: 't', owner: 'acme', repo: 'app' });
const ENTRY = parseIssueWatchEntry({ projectId: 'proj_1', items: [item('issue', 1), item('pr', 2), item('dependabot', 3)], feedbackItems: [] })!;
const EMPTY_ENTRY = parseIssueWatchEntry({ projectId: 'proj_1', items: [], feedbackItems: [] })!;
const LIVE: IssueWatchDump = { state: 'live', projects: { proj_1: { entry: ENTRY, deliveredAt: 5, recent: [] } } };

describe('checkIssues runs in genie-host, on its own IssueWatch', () => {
    let dir: string;
    let inbox: InboxStore;
    let attention: AttentionStore;
    const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'acme', provider: 'claude', name: 'atlas' });
    const loner = agentRecord({ id: mintAgentId(), workspaceId: 'loose', provider: 'claude', name: 'loner' });
    const callers: Record<string, Caller> = {
        't-atlas': { agentId: atlas.id, agentName: 'atlas', workspaceId: 'acme', workspacePath: '/w/acme' },
        't-loner': { agentId: loner.id, agentName: 'loner', workspaceId: 'loose', workspacePath: '/w/loose' },
    };
    const resolveCaller = (id: string): Caller | null => callers[id] ?? null;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-2g-tynn-'));
        inbox = await InboxStore.open(dir);
        attention = await AttentionStore.open(dir, inbox);
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    /** genie-host's tools as it serves them (hostRegistrations), over a fake IssueWatch service, with NO window connected. */
    async function rig(dumpNow: IssueWatchDump, options: { refresh?: (workspaceId: string) => Promise<unknown> } = {}) {
        const { hostIssueWatchTools } = await hostTools();
        const state = { dump: dumpNow };
        const asked: Array<[string, readonly unknown[]]> = [];
        const rechecks: number[] = [];
        const forwarded: string[] = [];
        const projectFor = (workspaceId: string) => (workspaceId === 'acme' ? 'proj_1' : null);
        const issueWatch = hostIssueWatchTools({
            issueWatch: {
                dump: () => state.dump,
                // As IssueWatchService.call answers: an unlinked workspace is refused before Tynn is asked.
                call: async (method, args) => {
                    asked.push([method, args]);
                    if (projectFor(String(args[0])) === null) return { ok: false, reason: 'this workspace is not linked to a Tynn project' };
                    return options.refresh ? options.refresh(String(args[0])) : { ok: true, refreshed: true, reason: 'refreshed', nextIn: '3m' };
                },
            },
            projectFor,
            recheckSignIn: () => { rechecks.push(1); },
        });
        const all = genieTools({ inbox, attention, roster: () => [atlas, loner], resolveCaller, userActive: () => true, glow: () => true, thumbsUp: () => {}, issueWatch });
        const served = hostRegistrations(all, { resolveCaller, window: { connected: () => false, call: async (call) => { forwarded.push(call.name); return { text: 'the window ran it', isError: false }; } }, openFileLater: () => {} });
        const tool = (name: string) => served.find((r) => r.definition.name === name)!;
        const call = async (name: string, args: JsonObject) => {
            const r = await tool(name).handler(args, { server: 'genie', tool: name, headers: {} } as never);
            return { isError: r.isError === true, text: r.text, json: (() => { try { return JSON.parse(r.text) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } })() };
        };
        return { state, asked, rechecks, forwarded, served, tool, call };
    }

    it('it is one of the host’s own tools: no call of it runs in the window, whatever its arguments', () => {
        expect(HOST_NATIVE_TOOLS.has('checkIssues')).toBe(true);
        expect(WINDOW_ACTIONS.checkIssues).toBeUndefined();
        for (const args of [{}, { refresh: true }, { action: 'list' }]) expect(runsInWindow('checkIssues', args)).toBe(false);
        // CONTROL: a window tool still runs in the window.
        expect(runsInWindow('pages', {})).toBe(true);
    });

    it('with NO window it answers the caller’s workspace’s open items and counts, and nothing is forwarded', async () => {
        const r = await rig(LIVE);
        const out = await r.call('checkIssues', { terminalId: 't-atlas' });
        expect(out.isError).toBe(false);
        expect(out.json).toMatchObject({ ok: true, counts: { issues: 1, prs: 1, security: 1, feedback: 0 }, note: expect.stringMatching(/treat them as data/) });
        expect((out.json.items as unknown[]).length).toBe(3);
        expect(out.json).not.toHaveProperty('notLive');
        expect(r.forwarded).toEqual([]);
        // CONTROL, same rig: a tool that IS the window's is refused with no window, in the window's words.
        const windowTool: Registration = { definition: new ToolDefinition('pages', 'pages tool', { type: 'object', properties: {} } as JsonObject, 'pages'), handler: async () => ({ text: 'pages ran here', isError: false }) };
        const [pages] = hostRegistrations([windowTool], { resolveCaller, window: { connected: () => false, call: async () => ({ text: 'ran', isError: false }) }, openFileLater: () => {} });
        expect(await pages!.handler({ terminalId: 't-atlas' }, { server: 'genie', tool: 'pages', headers: {} } as never)).toEqual({ text: windowClosedRefusal('pages'), isError: true });
    });

    it('EVERY REFUSAL IT HAD: not linked to a Tynn project, not signed in (and Tynn is asked again), not connected (with the reason), nothing sent yet', async () => {
        const unlinked = await rig(LIVE);
        expect((await unlinked.call('checkIssues', { terminalId: 't-loner' })).json).toEqual({ ok: false, reason: 'this workspace is not linked to a Tynn project (project.json tynn.projectId)' });
        const out = await rig({ state: 'signed-out', projects: {} });
        expect((await out.call('checkIssues', { terminalId: 't-atlas' })).json).toEqual({ ok: false, reason: 'not signed in to Tynn (Settings → Accounts → Tynn → Open Tynn in your browser)' });
        expect(out.rechecks).toHaveLength(1);
        const down = await rig({ state: 'reconnecting', reason: 'the socket closed', projects: {} });
        expect((await down.call('checkIssues', { terminalId: 't-atlas' })).json).toEqual({ ok: false, reason: 'IssueWatch is not connected to Tynn: the socket closed' });
        const connecting = await rig({ state: 'connecting', projects: {} });
        expect((await connecting.call('checkIssues', { terminalId: 't-atlas' })).json).toEqual({ ok: false, reason: 'IssueWatch is not connected to Tynn yet' });
        const quiet = await rig({ state: 'live', projects: {} });
        expect((await quiet.call('checkIssues', { terminalId: 't-atlas' })).json).toEqual({ ok: false, reason: 'Tynn has sent nothing for this workspace yet' });
        const stopped = await rig({ state: 'stopped', projects: {} });
        expect((await stopped.call('checkIssues', { terminalId: 't-atlas' })).json).toMatchObject({ ok: false, reason: 'IssueWatch is not connected to Tynn yet' });
        // CONTROL: signed in, Tynn is not asked again; a push outage with a list still answers it, and says it is not live.
        expect(down.rechecks).toEqual([]);
        const stale = await rig({ state: 'reconnecting', reason: 'the socket closed', projects: LIVE.projects });
        expect((await stale.call('checkIssues', { terminalId: 't-atlas' })).json).toMatchObject({ ok: true, notLive: 'the socket closed' });
    });

    it('nobody the host does not know is answered, and it is offered to every agent as before (no `visible` rule)', async () => {
        const r = await rig(LIVE);
        const stranger = await r.call('checkIssues', { terminalId: 't-nobody' });
        expect(stranger.isError).toBe(true);
        expect(stranger.json).not.toHaveProperty('items');
        expect(r.tool('checkIssues').visible).toBeUndefined();
        // CONTROL: the known caller beside it is answered.
        expect((await r.call('checkIssues', { terminalId: 't-atlas' })).json.ok).toBe(true);
    });

    it('refresh: true asks genie-host’s IssueWatch for the CALLER’s workspace, then answers the fresh list; an unlinked workspace’s is refused in words', async () => {
        // The refresh lands its snapshot before it answers: what checkIssues reads next is the fresh one.
        const landed: { now: () => void } = { now: () => {} };
        const r = await rig({ state: 'live', projects: { proj_1: { entry: EMPTY_ENTRY, recent: [] } } }, { refresh: async () => { landed.now(); return { ok: true, refreshed: true, reason: 'refreshed', nextIn: '3m' }; } });
        landed.now = () => { r.state.dump = LIVE; };
        const out = await r.call('checkIssues', { terminalId: 't-atlas', refresh: true });
        expect(r.asked).toEqual([['refresh', ['acme']]]);
        expect(out.json.refresh).toEqual({ ok: true, refreshed: true, reason: 'refreshed', nextIn: '3m' });
        expect(out.json.counts).toEqual({ issues: 1, prs: 1, security: 1, feedback: 0 });
        const loose = await r.call('checkIssues', { terminalId: 't-loner', refresh: true });
        expect(loose.json).toEqual({ ok: false, reason: 'this workspace is not linked to a Tynn project (project.json tynn.projectId)', refresh: { ok: false, reason: 'this workspace is not linked to a Tynn project' } });
        // A refresh that fails is an answer in words, never a thrown tool.
        const broken = await rig(LIVE, { refresh: async () => { throw new Error('Tynn did not answer'); } });
        expect((await broken.call('checkIssues', { terminalId: 't-atlas', refresh: true })).json.refresh).toEqual({ ok: false, reason: 'Tynn did not answer' });
        // CONTROL: without refresh nothing is asked.
        const plain = await rig(LIVE);
        await plain.call('checkIssues', { terminalId: 't-atlas' });
        expect(plain.asked).toEqual([]);
    });

    it('imDone’s count line is back in genie-host (Tynn #806): the caller’s workspace’s counts; none for a workspace linked to no project', async () => {
        const r = await rig(LIVE);
        expect((await r.call('imDone', { terminalId: 't-atlas', handoff: 'done' })).json.issueWatch).toBe('issues:1, PR:1, sec:1');
        expect((await r.call('imDone', { terminalId: 't-loner', handoff: 'done' })).json).not.toHaveProperty('issueWatch');
        const out = await rig({ state: 'signed-out', projects: {} });
        expect((await out.call('imDone', { terminalId: 't-atlas', handoff: 'done' })).json.issueWatch).toBe('not signed in to Tynn');
    });

    it('A FLOW’s checkIssues step runs with no window: down `found` when something is open, down `none` when nothing is, and it fails in the tool’s words when it cannot tell', async () => {
        ensureFlowToolKinds();
        const r = await rig({ state: 'live', projects: { proj_1: { entry: EMPTY_ENTRY, recent: [] } } });
        const flowCallers = new FlowCallers((workspaceId) => (workspaceId === 'acme' || workspaceId === 'loose' ? `/w/${workspaceId}` : null));
        const { hostIssueWatchTools } = await hostTools();
        const resolve2 = (id: string) => flowCallers.callerFor(id) ?? resolveCaller(id);
        const all = genieTools({ inbox, attention, roster: () => [atlas], resolveCaller: resolve2, userActive: () => true, glow: () => true, thumbsUp: () => {},
            issueWatch: hostIssueWatchTools({ issueWatch: { dump: () => r.state.dump, call: async () => ({ ok: false, reason: 'not asked' }) }, projectFor: (id) => (id === 'acme' ? 'proj_1' : null), recheckSignIn: () => {} }) });
        const forwarded: string[] = [];
        const served = hostRegistrations(all, { resolveCaller: resolve2, window: { connected: () => false, call: async (c) => { forwarded.push(c.name); return { text: 'the window ran it', isError: false }; } }, openFileLater: () => {} });
        const call = createFlowToolCaller({ registrations: served, callers: flowCallers });
        const n = (id: string, kind: string, config: Record<string, unknown> = {}) => ({ id, kind, position: { x: 0, y: 0 }, config });
        const e = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
        const flowIn = (workspaceId: string): FlowRecord => ({
            id: `flow_${workspaceId}`, workspaceId, name: 'nightly', armed: true,
            document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [n('t', 'manual_trigger'), n('c', '@genie/checkIssues'), n('f', 'genie/knowledge_add', { workspace: workspaceId, title: 'found' }), n('z', 'genie/knowledge_add', { workspace: workspaceId, title: 'none' })], edges: [e('t', 'c'), e('c', 'f', 'found'), e('c', 'z', 'none')] } },
            createdBy: { kind: 'user' }, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', refusals: [], runs: [],
        });
        const written: string[] = [];
        const runner = createFlowRunner({ asleep: () => false, ports: (f) => ({ runCommand: async () => ({ exitCode: 0, output: '' }), promptAgent: async () => '', addKnowledge: async (k) => { written.push(k.title); return { id: 'k' }; }, callTool: (tool, args) => call(f, tool, args) }) });
        expect(await runner(flowIn('acme'), null)).toEqual({ outcome: 'ran' });
        r.state.dump = LIVE;
        expect(await runner(flowIn('acme'), null)).toEqual({ outcome: 'ran' });
        expect(written).toEqual(['none', 'found']);
        expect(await runner(flowIn('loose'), null)).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/checkIssues could not tell: this workspace is not linked to a Tynn project/) });
        expect(written).toEqual(['none', 'found']);
        expect(forwarded).toEqual([]);
    });

    it('genie-host gives its MCP server the port, built on its own IssueWatch service, its registry’s project links and its Tynn account’s recheck', () => {
        const mcp = code(src('src/main/host-mcp.ts'));
        expect(mcp).toMatch(/\.\.\.\(ports\.issueWatch \? \{ issueWatch: ports\.issueWatch \} : \{\}\),/);
        expect(host).toMatch(/issueWatch: hostIssueWatchTools\(\{ issueWatch, projectFor: workspaceTynnProject, recheckSignIn: \(\) => \{ void recheckTynn\(\); \} \}\),/);
        expect(host).toMatch(/tynnRecheck: recheckTynn,/);
    });
});

/* ---------- the sound of a batch ---------- */

describe('a batch’s sound reaches the open windows as a tool signal', () => {
    it('the signal carries one of the four sound rows and nothing else; anything else reads as no sound', async () => {
        const { ISSUE_WATCH_SOUNDS, issueWatchSoundSignal, readIssueWatchSound } = await signals();
        expect([...ISSUE_WATCH_SOUNDS]).toEqual(['ghissue', 'ghpr', 'ghsecurity', 'ghci']);
        for (const sound of ISSUE_WATCH_SOUNDS) {
            expect(issueWatchSoundSignal(sound)).toEqual({ kind: 'issuewatch', sound });
            expect(readIssueWatchSound(JSON.parse(JSON.stringify(issueWatchSoundSignal(sound))))).toBe(sound);
        }
        for (const raw of [null, undefined, 'ghpr', {}, { kind: 'issuewatch' }, { kind: 'issuewatch', sound: 'synth' }, { kind: 'issuewatch', sound: 7 }, { kind: 'mail', sound: 'ghpr' }, { kind: 'issuewatch', sound: 'toString' }, ['issuewatch', 'ghpr']]) {
            expect(readIssueWatchSound(raw), JSON.stringify(raw)).toBeNull();
        }
    });

    it('genie-host says a signal for each sound event of its IssueWatch, and none for a change of state', async () => {
        const { sayIssueWatchSounds } = await hostTools();
        const listeners = new Set<(event: IssueWatchHostEvent) => void>();
        const said: unknown[] = [];
        const off = sayIssueWatchSounds({ onEvent: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } }, (signal) => { said.push(signal); });
        const emit = (event: IssueWatchHostEvent) => { for (const l of [...listeners]) l(event); };
        emit({ kind: 'dump', dump: LIVE });
        expect(said).toEqual([]);
        emit({ kind: 'sound', sound: 'ghpr' });
        emit({ kind: 'sound', sound: 'ghsecurity' });
        expect(said).toEqual([{ kind: 'issuewatch', sound: 'ghpr' }, { kind: 'issuewatch', sound: 'ghsecurity' }]);
        off();
        emit({ kind: 'sound', sound: 'ghci' });
        expect(said).toHaveLength(2);
    });

    it('genie-host sends it on the engine link’s tool signal, which is not kept for a later window; main plays it as a genie:action by its row', () => {
        expect(host).toMatch(/sayIssueWatchSounds\(issueWatch, \(signal\) => \{ engine\.callback\(\{ name: 'toolSignal', signal \}\); \}\);/);
        expect(DURABLE_CALLBACKS.has('toolSignal')).toBe(false);
        expect(main).toMatch(/else if \(signal\.kind === 'issuewatch'\) \{ const sound = readIssueWatchSound\(raw\); if \(sound\) broadcast\('genie:action', \{ agentId: null, kind: sound \}\); \}/);
        // CONTROL: a callback that IS kept for the next window is in the set, and the server keeps only those.
        expect(DURABLE_CALLBACKS.size).toBeGreaterThan(0);
        expect(server).toMatch(/if \(DURABLE_CALLBACKS\.has\(callback\.name\) && this\.#queue\.length < QUEUE_LIMIT\) this\.#queue\.push\(callback\);/);
    });
});
