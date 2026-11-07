import { describe, expect, it } from 'vitest';
import { ProcessSupervisor, type ProcessSpec } from '../src/main/process-supervisor.js';
import type { ListedPty } from '../src/main/spawn-host-protocol.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * A NEW WINDOW TAKES BACK WHAT IS STILL RUNNING (the host split, P2.1: plan §11a).
 *
 * Under genie-host a site's server, a queue worker and the front door keep running while the window restarts. The new
 * window's supervisor must not start them a second time (two servers on one port; the phone's bookmark moving): the live
 * ptys are ADOPTED, and the first start of the same process CLAIMS its pty instead of spawning. Whatever nobody claims
 * (no longer wanted) is ended, and said, never left running where no window can see it.
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const killed: string[] = [];
    const data = new Set<(id: string, d: string) => void>();
    const exit = new Set<(id: string, code: number) => void>();
    const live = new Set<string>(['term_site', 'term_worker']); // already running under the host
    let n = 0;
    const port: PtyPort = {
        open(options) { const id = `term_${++n}`; opened.push({ ...options, id }); live.add(id); return { id, pid: 2000 + n, shell: options.command ?? '', scrollback: '' } satisfies PtyOpened; },
        write: () => true,
        resize: () => true,
        kill(id) { if (!live.delete(id)) return false; killed.push(id); return true; },
        scrollback: () => undefined,
        onData: (l) => { data.add(l); return () => data.delete(l); },
        onExit: (l) => { exit.add(l); return () => exit.delete(l); },
        isLive: (id) => live.has(id),
    };
    return { port, opened, killed, live, output: (id: string, d: string) => { for (const l of data) l(id, d); }, exits: (id: string, code: number) => { live.delete(id); for (const l of exit) l(id, code); } };
}

const spec = (id: string, over: Partial<ProcessSpec> = {}): ProcessSpec => ({ id, workspaceId: 'ws', name: id, command: 'php artisan serve --port=4102', cwd: '/w', restart: 'on-failure', ...over });
const listed = (id: string, processId: string, pid: number, scrollback = ''): ListedPty => ({ id, pid, tag: { kind: 'process', processId, workspaceId: 'ws' }, scrollback });

describe('adopting a running process after a window restart', () => {
    it('the first start of an adopted process CLAIMS its pty: nothing is spawned, same pid, running, its earlier output in the log', () => {
        const pty = fakePty();
        const sup = new ProcessSupervisor(pty.port);
        sup.adopt(listed('term_site', 'site:shop', 7001, 'Server running on http://127.0.0.1:4102\r\n'));
        const status = sup.start(spec('site:shop'));
        expect(pty.opened).toEqual([]); // not started a second time
        expect(status).toMatchObject({ id: 'site:shop', state: 'running', pid: 7001 });
        expect(sup.log('site:shop')).toContain('Server running on http://127.0.0.1:4102');
        expect(sup.log('site:shop')).toMatch(/re-attached/);
    });

    it('a claimed process behaves as its own: its output is its log, and its exit follows its restart policy', () => {
        const pty = fakePty();
        const sup = new ProcessSupervisor(pty.port, { now: () => 0, schedule: () => () => {} });
        sup.adopt(listed('term_worker', 'queue', 7002));
        sup.start(spec('queue', { command: 'php artisan queue:work' }));
        pty.output('term_worker', 'Processing job 1\r\n');
        expect(sup.log('queue')).toContain('Processing job 1');
        pty.exits('term_worker', 1);
        expect(sup.status('queue')?.state).toBe('restarting');
    });

    it('a start of a process with no adopted pty spawns as before, with its tag (so the NEXT window can claim it)', () => {
        const pty = fakePty();
        const sup = new ProcessSupervisor(pty.port);
        sup.adopt(listed('term_site', 'site:shop', 7001));
        sup.start(spec('site:blog'));
        expect(pty.opened).toHaveLength(1);
        expect(pty.opened[0]!.tag).toEqual({ kind: 'process', processId: 'site:blog', workspaceId: 'ws' });
    });

    it('an adopted pty that ends before it is claimed is let go: the next start spawns it fresh', () => {
        const pty = fakePty();
        const sup = new ProcessSupervisor(pty.port);
        sup.adopt(listed('term_site', 'site:shop', 7001));
        pty.exits('term_site', 0);
        sup.start(spec('site:shop'));
        expect(pty.opened).toHaveLength(1);
    });

    it('what nobody claimed is ENDED by reapUnclaimed, and named — never left running where no window sees it', () => {
        const pty = fakePty();
        const sup = new ProcessSupervisor(pty.port);
        sup.adopt(listed('term_site', 'site:shop', 7001));
        sup.adopt(listed('term_worker', 'queue', 7002));
        sup.start(spec('site:shop'));
        expect(sup.reapUnclaimed()).toEqual([{ processId: 'queue', pid: 7002 }]);
        expect(pty.killed).toEqual(['term_worker']);
        expect(sup.status('site:shop')?.state).toBe('running'); // the claimed one is untouched
    });
});
