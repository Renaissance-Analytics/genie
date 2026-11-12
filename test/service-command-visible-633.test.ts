import { describe, expect, it } from 'vitest';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SupervisorService } from '../src/main/supervisor-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ledgerRow } from '../src/core/stream-view.js';
import type { StreamEvent } from '../src/core/stream-event.js';

// A command already has its executor. Observation must never launch another shell or persist a restart policy.
function rig() {
    let now = 1_760_000_000_000;
    const calls = { opened: 0, cancelled: 0 };
    const pty: PtyPort = {
        open: () => { calls.opened += 1; return { id: 'plain-terminal', pid: 10, shell: 'fixture-shell', scrollback: '' }; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
    const supervisor = new ProcessSupervisor(pty, { now: () => now, schedule: () => () => {} });
    const service = new SupervisorService(supervisor);
    const spec = { id: 'service-command-1', workspaceId: 'work', name: 'services exec', command: 'php artisan test', cwd: '/workspace' };
    const track = () => supervisor.trackExternal(spec, { pid: 123, stop: () => { calls.cancelled += 1; } });
    return { supervisor, service, spec, track, calls, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('service commands are visible workspace work (#633)', () => {
    it('publishes the existing run with its workspace, command and start time, without a second spawn', () => {
        const w = rig(); w.track();
        expect(w.supervisor.list('work')).toMatchObject([{ id: w.spec.id, workspaceId: 'work', state: 'running', pid: 123, since: w.now(), commandRun: true }]);
        expect(w.supervisor.list('someone-else')).toEqual([]);
        expect(w.supervisor.command(w.spec.id)).toBe('php artisan test');
        expect(w.calls.opened).toBe(0);
        expect(w.service.dump().statuses).toMatchObject([{ id: w.spec.id }]);
    });

    it('streams output through the existing supervisor event/log path and replays it on window reconnect', () => {
        const w = rig(); const events: unknown[] = [];
        w.service.onEvent((event) => events.push(event));
        const run = w.track(); run.output('first line\n'); run.output('second line\n');
        expect(w.supervisor.readLog(w.spec.id)?.text).toBe('first line\nsecond line');
        expect(events).toContainEqual({ kind: 'output', id: w.spec.id, data: 'second line\n' });
        expect(w.service.dump().logs[w.spec.id]).toBe('first line\nsecond line');
    });

    it('the existing Stop action cancels this run exactly once and completion stays visible', () => {
        const w = rig(); const run = w.track();
        expect(w.supervisor.stop(w.spec.id)).toBe(true);
        w.supervisor.stop(w.spec.id);
        expect(w.calls.cancelled).toBe(1);
        run.output('command stopped\n'); run.finish(null, true);
        expect(w.supervisor.status(w.spec.id)).toMatchObject({ state: 'stopped', pid: null });
        expect(w.supervisor.log(w.spec.id)).toContain('command stopped');
        expect(w.calls.opened).toBe(0);
    });

    it.each([0, 1])('a completed command keeps exit code %s and its log, with no automatic or manual restart', (code) => {
        const w = rig(); const run = w.track(); run.output('done\n'); w.advance(500); run.finish(code);
        expect(w.supervisor.status(w.spec.id)).toMatchObject({ state: code === 0 ? 'exited' : 'failed', exitCode: code, since: w.now(), pid: null });
        expect(w.supervisor.restart(w.spec.id)).toBeNull();
        expect(w.supervisor.log(w.spec.id)).toContain('done');
        expect(w.calls.opened).toBe(0);
    });

    it('a tracked command cannot be forgotten while still running or overwritten by another run', () => {
        const w = rig(); const run = w.track();
        expect(w.supervisor.forget(w.spec.id)).toBe(false);
        expect(() => w.track()).toThrow();
        run.finish(0);
        expect(w.supervisor.forget(w.spec.id)).toBe(true);
        expect(w.supervisor.status(w.spec.id)).toBeNull();
    });

    it('CONTROL: an ordinary supervised process still starts one shell', () => {
        const w = rig();
        w.supervisor.start({ ...w.spec, id: 'ordinary-worker', restart: 'never' });
        expect(w.calls.opened).toBe(1);
        expect(w.supervisor.list('work')).toHaveLength(1);
    });
});

describe('the service command ledger label (#633)', () => {
    it.each(['mcp__genie__services', 'genie.services'])('%s names the known operation without changing the provider kind', (name) => {
        const event: StreamEvent = { kind: 'tool', toolCallId: 'call-1', name, title: 'services', status: 'in_progress', toolKind: null, rawInput: { action: 'exec', command: 'php artisan test' } };
        const row = ledgerRow({ id: 'row-1', at: 1, event });
        expect(row.main).toMatch(/^Running .*php artisan test.*services/);
        expect(row.note ?? '').not.toContain('kind not reported');
        expect(event.toolKind).toBeNull();
    });

    it('CONTROL: an unrelated MCP tool still reports an unknown kind honestly', () => {
        const event: StreamEvent = { kind: 'tool', toolCallId: 'call-2', name: 'mcp__other__services', title: null, status: 'in_progress', toolKind: null, rawInput: { action: 'exec', command: 'synthetic' } };
        expect(ledgerRow({ id: 'row-2', at: 1, event }).note).toBe('(kind not reported)');
    });
});
