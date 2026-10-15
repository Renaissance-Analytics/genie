import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { genieToolDeps } from '../src/main/genie-tool-deps.js';
import { allGenieTools } from '../src/main/mcp-registrations.js';
import { processTools } from '../src/main/mcp-tools-processes.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import { ProcessBook } from '../src/main/process-book.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * AGENTS KEEP BACKGROUND PROCESSES THROUGH GENIE (the hosting ship line P3; Genie 1's `manageProcess`). The `processes`
 * tool runs against the REAL composition, the REAL process book and the REAL approval queue — what an agent does is what
 * Hosting → Processes does: same validation, same records, same supervisor. The pty is a fake that can print and exit.
 * Every claim is counted; every refusal is checked for having done NOTHING, beside a control that does something.
 */

const opened: Array<{ id: string; command?: string | undefined; cwd: string; env?: Readonly<Record<string, string>> | undefined }> = [];
const killed: string[] = [];
const live = new Set<string>();
const dataListeners = new Set<(id: string, d: string) => void>();
const exitListeners = new Set<(id: string, code: number) => void>();
const pty: PtyPort = {
    open: (o) => { const id = `term_${opened.length + 1}`; opened.push({ id, command: o.command, cwd: o.cwd, env: o.env }); live.add(id); return { id, pid: 5000 + opened.length, shell: o.command ?? 'sh', scrollback: '' }; },
    write: () => true,
    resize: () => true,
    kill: (id) => { if (!live.delete(id)) return false; killed.push(id); return true; },
    scrollback: () => '',
    isLive: (id) => live.has(id),
    onData: (l) => { dataListeners.add(l); return () => dataListeners.delete(l); },
    onExit: (l) => { exitListeners.add(l); return () => exitListeners.delete(l); },
};
const print = (id: string, d: string) => { for (const l of dataListeners) l(id, d); };
const exit = (id: string, code: number) => { live.delete(id); for (const l of exitListeners) l(id, code); };
const docker: DockerRunner = async () => ({ stdout: '', exitCode: 1 });

let dir: string;
let services: ComposedServices;
let book: ProcessBook;
let tools: Registration[];
const callers: Record<string, Caller> = {};
const ws = (id: string) => join(dir, id);

async function call(terminalId: string, args: JsonObject, set: Registration[] = tools) {
    const reg = set.find((t) => t.definition.name === 'processes')!;
    const r = await reg.handler({ ...args, terminalId }, { server: 'genie', tool: 'processes', headers: {} });
    return { ...r, json: JSON.parse(r.text) as Record<string, any> };
}

/** The approval the call is waiting on, once it has asked. */
async function asked(): Promise<{ id: string; title: string }> {
    for (let i = 0; i < 200 && services.approvals.deckItems().length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    const [item] = services.approvals.deckItems();
    expect(item).toBeDefined();
    return { id: item!.id, title: item!.title };
}

/** A process the PERSON keeps in a workspace (Hosting → Processes), the way the tab adds one. */
const keep = (workspaceId: string, name: string, command = 'php artisan queue:work') =>
    book.create({ workspaceId, workspacePath: ws(workspaceId), name, command, restart: 'on-failure' });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-processes-'));
    opened.length = 0;
    killed.length = 0;
    live.clear();
    dataListeners.clear();
    exitListeners.clear();
    for (const w of ['example', 'example-other']) await mkdir(ws(w), { recursive: true });
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker, portFree: async () => true });
    book = await ProcessBook.open(dir, { supervisor: services.supervisor, envFor: (id) => ({ GENIE_WS: id }), asleep: () => false });
    callers['t-example'] = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'example', workspacePath: ws('example') };
    callers['t-other'] = { agentId: mintAgentId(), agentName: 'vega', workspaceId: 'example-other', workspacePath: ws('example-other') };
    tools = processTools({
        resolveCaller: (id) => callers[id] ?? null,
        approve: (c, a, d) => services.approvals.gate(c, a, d),
        processes: { book, logs: (id, lines) => services.supervisor.readLog(id, lines) },
    });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('processes: what an agent sees', () => {
    it('list is its own workspace’s processes only — counted, both ways', async () => {
        await keep('example', 'queue');
        await keep('example', 'watcher', 'npm run watch');
        await keep('example-other', 'other-queue');
        const mine = await call('t-example', { action: 'list' });
        expect(mine.isError).toBe(false);
        expect(mine.json.processes.map((p: any) => p.name).sort()).toEqual(['queue', 'watcher']);
        expect(mine.json.processes[0]).toMatchObject({ state: 'running', kept: true });
        const theirs = await call('t-other', { action: 'list' });
        expect(theirs.json.processes.map((p: any) => p.name)).toEqual(['other-queue']);
    });

    it('logs: the output and the crash, after the process died — counted lines, and `lines` takes the end', async () => {
        const s = await keep('example', 'queue');
        print('term_1', 'Processing job 1\nPDOException: could not connect\n');
        exit('term_1', 1);
        const r = await call('t-example', { action: 'logs', process: 'queue' });
        expect(r.isError).toBe(false);
        expect(r.json.process).toMatchObject({ id: s.id, state: 'restarting', exitCode: 1 });
        expect(r.json.log.split('\n')).toEqual([
            '[genie] started (pid 5001): php artisan queue:work',
            'Processing job 1',
            'PDOException: could not connect',
            '[genie] exited with code 1; restarting in 1s',
        ]);
        expect(r.json.lines).toBe(4);
        const end = await call('t-example', { action: 'logs', process: s.id, lines: 2 });
        expect(end.json.log.split('\n')).toEqual(['PDOException: could not connect', '[genie] exited with code 1; restarting in 1s']);
    });

    it('logs reads a site’s server too; start/stop/restart/remove of one are refused, pointing at `sites` (nothing killed)', async () => {
        services.supervisor.start({ id: 'site:docs', workspaceId: 'example', name: 'docs dev server', command: 'npm run dev', cwd: ws('example'), restart: 'on-failure' });
        print('term_1', 'VITE ready\n');
        const logs = await call('t-example', { action: 'logs', process: 'site:docs' });
        expect(logs.json.log).toContain('VITE ready');
        const refused = await Promise.all(['start', 'stop', 'restart', 'remove'].map((action) => call('t-example', { action, process: 'docs dev server' })));
        expect(refused.filter((r) => r.isError && /`sites`/.test(r.json.error))).toHaveLength(4);
        expect(killed).toEqual([]);
        expect(services.approvals.deckItems()).toHaveLength(0);
    });
});

describe('processes: never another workspace’s', () => {
    it('every action on another workspace’s process is refused with NO side effect (control: its own agent’s stop works)', async () => {
        const s = await keep('example', 'queue');
        const before = JSON.stringify(book.kept());
        const refused = await Promise.all(['logs', 'start', 'stop', 'restart', 'remove'].map((action) => call('t-other', { action, process: s.id })));
        expect(refused.filter((r) => r.isError && /not one of this workspace’s processes/.test(r.json.error))).toHaveLength(5);
        // By name too: a name is looked up among the caller's own rows only.
        expect((await call('t-other', { action: 'stop', process: 'queue' })).isError).toBe(true);
        expect(killed).toEqual([]);
        expect(opened).toHaveLength(1);
        expect(JSON.stringify(book.kept())).toBe(before);
        expect(services.supervisor.status(s.id)!.state).toBe('running');
        expect(services.approvals.deckItems()).toHaveLength(0);

        const own = await call('t-example', { action: 'stop', process: s.id });
        expect(own.isError).toBe(false);
        expect(killed).toEqual(['term_1']);
    });
});

describe('processes: add and remove wait for the person', () => {
    it('add asks first, naming the command; nothing starts or is kept until Allow — then it runs in the workspace, kept', async () => {
        const pending = call('t-example', { action: 'add', name: 'queue', command: 'php artisan queue:work', folder: 'app' });
        const q = await asked();
        expect(q.title).toMatch(/^atlas wants to keep a background process running: queue: `php artisan queue:work` in .*app, restart on-failure/);
        expect(opened).toHaveLength(0);
        expect(book.kept()).toHaveLength(0);
        services.approvals.resolve(q.id, 'allow');
        const r = await pending;
        expect(r.isError).toBe(false);
        expect(r.json.process).toMatchObject({ name: 'queue', state: 'running', kept: true, command: 'php artisan queue:work' });
        expect(opened).toEqual([expect.objectContaining({ command: 'php artisan queue:work', cwd: join(ws('example'), 'app'), env: { GENIE_WS: 'example' } })]);
        expect(book.kept()).toEqual([expect.objectContaining({ workspaceId: 'example', name: 'queue', wanted: true })]);
    });

    it('a DENIED add creates nothing: no pty, nothing kept, nothing written', async () => {
        const pending = call('t-example', { action: 'add', name: 'queue', command: 'php artisan queue:work' });
        services.approvals.resolve((await asked()).id, 'deny');
        const r = await pending;
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/denied by the person; nothing was started or kept/);
        expect(opened).toHaveLength(0);
        expect(book.kept()).toHaveLength(0);
        await expect(readFile(join(dir, 'runtime', 'processes.json'), 'utf8')).rejects.toThrow();
    });

    it('a request Genie would refuse is refused BEFORE the person is asked — counted', async () => {
        const refused = [
            await call('t-example', { action: 'add', name: 'queue', command: 'php artisan queue:work', folder: '../example-other' }),
            await call('t-example', { action: 'add', name: 'queue', command: 'php artisan queue:work', folder: join(dir, 'elsewhere') }),
            await call('t-example', { action: 'add', name: 'queue' }),
            await call('t-example', { action: 'add', command: 'x' }),
            await call('t-example', { action: 'add', name: 'queue', command: 'x', restart: 'sometimes' }),
        ];
        expect(refused.filter((r) => r.isError)).toHaveLength(5);
        expect(refused[0]!.json.error).toMatch(/inside the workspace/);
        expect(services.approvals.deckItems()).toHaveLength(0);
        expect(opened).toHaveLength(0);
    });

    it('remove asks; denied keeps it, allowed forgets it (stopped, gone from the list, not brought back)', async () => {
        const s = await keep('example', 'queue');
        const denied = call('t-example', { action: 'remove', process: 'queue' });
        const q1 = await asked();
        expect(q1.title).toMatch(/wants to remove a background process: queue/);
        services.approvals.resolve(q1.id, 'deny');
        expect((await denied).isError).toBe(true);
        expect(book.kept().map((p) => p.id)).toEqual([s.id]);
        expect(killed).toEqual([]);

        const allowed = call('t-example', { action: 'remove', process: 'queue' });
        services.approvals.resolve((await asked()).id, 'allow');
        expect((await allowed).json).toMatchObject({ ok: true, removed: s.id });
        expect(book.kept()).toHaveLength(0);
        expect(killed).toEqual(['term_1']);
        expect((await call('t-example', { action: 'list' })).json.processes).toEqual([]);
    });
});

describe('processes: start, stop and restart act at once', () => {
    it('stop is written down as the person’s would be; start brings it back; restart is a new run — counted ptys', async () => {
        const s = await keep('example', 'queue');
        const stopped = await call('t-example', { action: 'stop', process: 'queue' });
        expect(stopped.json.process).toMatchObject({ state: 'stopped' });
        expect(book.kept()[0]!.wanted).toBe(false);
        const started = await call('t-example', { action: 'start', process: 'queue' });
        expect(started.json.process).toMatchObject({ state: 'running' });
        expect(book.kept()[0]!.wanted).toBe(true);
        await call('t-example', { action: 'restart', process: s.id });
        expect(opened.map((o) => o.id)).toEqual(['term_1', 'term_2', 'term_3']);
        expect(killed).toEqual(['term_1', 'term_2']);
        expect(services.approvals.deckItems()).toHaveLength(0);
    });
});

describe('processes: wiring', () => {
    it('nobody Genie knows is refused; a Genie with no processes (doctor) says so; the normal wiring reaches the book (control)', async () => {
        expect((await call('t-nobody', { action: 'list' })).json.error).toMatch(/not one Genie knows/);
        const none = processTools({ resolveCaller: (id) => callers[id] ?? null, approve: async () => 'denied', processes: null });
        expect((await call('t-example', { action: 'list' }, none)).json.error).toMatch(/keeps no background processes/);

        await keep('example', 'queue');
        const never = (() => { throw new Error('not exercised'); }) as never;
        const wired = allGenieTools(genieToolDeps({
            inbox: never, attention: never, knowledge: never, settings: never, feedback: never, approve: async () => 'denied', roster: () => [], resolveCaller: (id) => callers[id] ?? null,
            userActive: () => true, glow: () => false, thumbsUp: () => {}, openFile: never, terminals: never,
            processes: { book, logs: (id, lines) => services.supervisor.readLog(id, lines) },
            sidecar: { register: never, start: never, running: () => false },
            plugins: { tools: () => [], guard: () => null, run: never },
        }));
        const r = await call('t-example', { action: 'list' }, wired);
        expect(r.isError).toBe(false);
        expect(r.json.processes.map((p: any) => p.name)).toEqual(['queue']);
    });

    it('tells an agent Genie keeps it running and never to leave one in a terminal, and carries a title', () => {
        const [t] = tools;
        expect(t!.definition.name).toBe('processes');
        expect(t!.definition.description).toMatch(/kept running by GENIE/);
        expect(t!.definition.description).toMatch(/never leave one running in a terminal/);
        expect(t!.definition.title).toBe('Processes');
    });
});
