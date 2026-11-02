import { describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { ProcessSupervisor, type ProcessSpec } from '../src/main/process-supervisor.js';
import { SupervisorService } from '../src/main/supervisor-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import type { PtyOpened, PtyPort } from '../src/main/terminal-host.js';

/**
 * THE PROCESS SUPERVISOR IS GENIE-HOST'S (the host split, P3.3b: plan §11e, decision 1a). Its restart policy and logs run
 * in the host, so a crashed queue worker restarts with the UI closed; a window drives it through a replica (sites, the
 * front door, the Processes view) that reads synchronously and answers in the host's words. The three things the person
 * relies on:
 *  1. with NO window, a crashed `restart: always` process is started again by the host — and the next window shows it;
 *  2. Stop from a window ends it for good: the host does not restart it;
 *  3. a window that comes back and starts its sites again does not start them twice (the phone's site keeps serving).
 */

const TOKEN = 'supervisor-token';
const tick = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function fakePty() {
    const opened: string[] = [];
    const live = new Set<string>();
    const data = new Set<(id: string, d: string) => void>();
    const exit = new Set<(id: string, code: number) => void>();
    let n = 0;
    const port: PtyPort = {
        open(options) { n += 1; const id = `term_${n}`; opened.push(options.command ?? ''); live.add(id); return { id, pid: 3000 + n, shell: options.command ?? '', scrollback: '' } satisfies PtyOpened; },
        write: () => true,
        resize: () => true,
        kill(id) { if (!live.delete(id)) return false; for (const l of exit) l(id, 0); return true; },
        scrollback: () => undefined,
        onData: (l) => { data.add(l); return () => data.delete(l); },
        onExit: (l) => { exit.add(l); return () => exit.delete(l); },
        isLive: (id) => live.has(id),
    };
    const lastId = () => `term_${n}`;
    return { port, opened, output: (d: string) => { for (const l of data) l(lastId(), d); }, crash: () => { const id = lastId(); live.delete(id); for (const l of exit) l(id, 1); } };
}

function rig() {
    const pty = fakePty();
    const timers: Array<() => void> = [];
    const supervisor = new ProcessSupervisor(pty.port, { now: () => 1_000, schedule: (fn) => { timers.push(fn); return () => {}; } });
    const service = new SupervisorService(supervisor);
    const server = new SessionEngineServer({ token: TOKEN, build: 't', supervisor: service });
    const window = async () => {
        const [h, w] = memoryPair();
        server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        return { replica: client.supervisor(), close: () => w.close() };
    };
    return { pty, supervisor, window, runTimers: () => { for (const t of timers.splice(0)) t(); } };
}

const worker = (over: Partial<ProcessSpec> = {}): ProcessSpec => ({ id: 'proc:queue', workspaceId: 'ws', name: 'queue', command: 'php artisan queue:work', cwd: '/w', restart: 'always', ...over });

describe('the supervisor in genie-host, driven from a window', () => {
    it('a window starts a process: it runs in the host; the window reads its status, its list and its output', async () => {
        const r = rig();
        const w = await r.window();
        w.replica.start(worker());
        await tick();
        expect(r.supervisor.status('proc:queue')?.state).toBe('running');
        expect(w.replica.status('proc:queue')).toEqual(r.supervisor.status('proc:queue'));
        expect(w.replica.list()).toEqual(r.supervisor.list());
        const heard: string[] = [];
        w.replica.onOutput((id, d) => heard.push(`${id}:${d}`));
        r.pty.output('Processing jobs\n');
        await tick();
        expect(heard).toEqual(['proc:queue:Processing jobs\n']);
        expect(w.replica.readLog('proc:queue')?.text).toContain('Processing jobs');
    });

    it('with NO window, a crashed `restart: always` process is started again by the host — and the next window shows it', async () => {
        const r = rig();
        const first = await r.window();
        first.replica.start(worker());
        await tick();
        first.close();
        await tick();
        const spawnsBefore = r.pty.opened.length;
        r.pty.crash();
        r.runTimers(); // the restart's backoff elapses — no window anywhere
        await tick();
        expect(r.pty.opened.length).toBe(spawnsBefore + 1);
        const next = await r.window();
        expect(next.replica.status('proc:queue')).toMatchObject({ state: 'running', restarts: 1 });
        expect(next.replica.status('proc:queue')).toEqual(r.supervisor.status('proc:queue'));
    });

    it('Stop from a window ends it FOR GOOD: the host does not restart it (CONTROL for the restart above)', async () => {
        const r = rig();
        const w = await r.window();
        w.replica.start(worker());
        await tick();
        expect(w.replica.stop('proc:queue')).toBe(true);
        await tick();
        const spawns = r.pty.opened.length;
        r.runTimers();
        await tick();
        expect(r.pty.opened.length).toBe(spawns);
        expect(r.supervisor.status('proc:queue')?.state).toBe('stopped');
        expect(w.replica.status('proc:queue')?.state).toBe('stopped');
    });

    it('a window that comes back and starts its sites again starts nothing twice: the phone\'s site keeps serving', async () => {
        const r = rig();
        const first = await r.window();
        first.replica.start(worker({ id: 'site:shop', command: 'php artisan serve --port=4102', restart: 'on-failure' }));
        await tick();
        const pid = r.supervisor.status('site:shop')?.pid;
        first.close();
        await tick();
        const second = await r.window();
        second.replica.start(worker({ id: 'site:shop', command: 'php artisan serve --port=4102', restart: 'on-failure' }));
        await tick();
        expect(r.pty.opened.filter((c) => c.includes('serve')).length).toBe(1);
        expect(r.supervisor.status('site:shop')?.pid).toBe(pid);
    });
});
