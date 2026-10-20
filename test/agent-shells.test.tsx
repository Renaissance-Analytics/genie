import { describe, expect, it } from 'vitest';
import { agentShells } from '../src/core/agent-shells.js';
import { toStreamEvent, type StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE SHELLS TAB'S DATA (the owner, 2026-10-14: "I should have some kind of indicator if you have any shells running.
 * I NEED TO SEE EVERYTHING AN AGENT IS DOING" — "this should be an extra tab after Changes").
 *
 * Two sources, both already in the agent's ledger:
 * - its own tool calls: a Bash call with `run_in_background: true` (the command it started), and a Genie
 *   `manageTerminals` create (a terminal it opened in the workspace);
 * - Claude's background-task frames, mapped by prism-acp to debug notices: `particle.academy/task` (started / updated
 *   / ended, joined to the Bash call by its tool-use id) and `particle.academy/background_tasks` (the FULL live set).
 *   Claude sends no set at startup, so a new process (`run`) starts from nothing.
 * Without the frames (an older prism, or Codex) a background command is listed with its state NOT REPORTED — never
 * guessed as running or finished.
 */

let n = 0;
const row = (event: StreamEvent, at: number): TimedEvent => ({ id: `r${++n}`, event, at });
const wire = (update: Record<string, unknown>, at: number): TimedEvent => row(toStreamEvent(update)!, at);
const bash = (id: string, command: string, background: boolean, at: number) =>
    wire({ sessionUpdate: 'tool_call', toolCallId: id, title: command, kind: 'execute', status: 'completed', rawInput: { command, description: `run ${command}`, ...(background ? { run_in_background: true } : {}) } }, at);
const task = (payload: Record<string, unknown>, at: number) =>
    wire({ sessionUpdate: 'notice', notice: { level: 'debug', message: `task ${String(payload.event)}` }, _meta: { 'particle.academy/task': payload } }, at);
const live = (tasks: readonly Record<string, unknown>[], at: number) =>
    wire({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'background tasks' }, _meta: { 'particle.academy/background_tasks': tasks } }, at);

describe('the frames reach the ledger', () => {
    it('a task notice and a live-set notice keep their payloads on the event (and persist with it)', () => {
        const t = toStreamEvent({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'task started' }, _meta: { 'particle.academy/task': { event: 'started', taskId: 'b1', toolUseId: 'tu1', taskType: 'local_bash', description: 'dev server' } } });
        expect(t).toMatchObject({ kind: 'notice', task: { event: 'started', taskId: 'b1', toolUseId: 'tu1' } });
        const s = toStreamEvent({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'background tasks' }, _meta: { 'particle.academy/background_tasks': [{ taskId: 'b1', taskType: 'local_bash', description: 'dev server' }] } });
        expect(s).toMatchObject({ kind: 'notice', tasks: [{ taskId: 'b1' }] });
        expect(JSON.parse(JSON.stringify(s))).toMatchObject({ tasks: [{ taskId: 'b1' }] });
    });
});

describe('agentShells', () => {
    it('a background command joined to its task: running, then ended with Claude\'s summary — a foreground command is not a shell', () => {
        const rows = [
            bash('tu1', 'npm run dev', true, 1000),
            bash('tu2', 'ls', false, 1100),
            task({ event: 'started', taskId: 'b1', toolUseId: 'tu1', taskType: 'local_bash', description: 'dev server', isBackgrounded: true }, 1200),
            live([{ taskId: 'b1', taskType: 'local_bash', description: 'dev server' }], 1201),
        ];
        const now = agentShells(rows);
        // COUNTED: one shell, running, with the command it ran.
        expect(now.running).toHaveLength(1);
        expect(now.running[0]).toMatchObject({ kind: 'shell', command: 'npm run dev', state: 'running', startedAt: 1000 });
        expect(now.ended).toHaveLength(0);
        expect(now.reported).toBe(true);

        const later = agentShells([
            ...rows,
            task({ event: 'ended', taskId: 'b1', toolUseId: 'tu1', status: 'failed', summary: 'exit 1', outputFile: '/tmp/b1.out' }, 5000),
            live([], 5001),
        ]);
        expect(later.running).toHaveLength(0);
        expect(later.ended).toEqual([expect.objectContaining({ command: 'npm run dev', state: 'failed', summary: 'exit 1', outputFile: '/tmp/b1.out', endedAt: 5000 })]);
    });

    /*
     * THE ORDER CLAUDE REALLY SENDS (beta.33 item 21; the owner's Shells tab: "STARTED IN THE BACKGROUND — STATE NOT
     * REPORTED · 6"). Measured on the owner's recorded threads (~/.genie/runtime/sessions, 2026-10-20): in all of them —
     * 49, 41 and 15 background commands — every task was named FIRST by the live set (`background_tasks_changed`, which
     * carries no tool-use id) and only then by its `task_started` (which does). The join keyed on the first sighting, so
     * the task was a nameless `task` and the command stayed "not reported" forever. The fixture above sends them the
     * other way round, which is why it passed.
     */
    it('the live set naming a task BEFORE its started event (Claude’s real order): still joined to its command', () => {
        const rows = [
            bash('tu1', 'npm test', true, 1000),
            live([{ taskId: 'b1', taskType: 'local_bash', description: 'run the suite' }], 1001),
            task({ event: 'started', taskId: 'b1', toolUseId: 'tu1', taskType: 'local_bash', description: 'run the suite' }, 1002),
        ];
        const now = agentShells(rows);
        expect(now.unreported).toEqual([]);
        expect(now.running.map((s) => [s.key, s.kind, s.command, s.state, s.startedAt])).toEqual([['b1', 'shell', 'npm test', 'running', 1000]]);
        const done = agentShells([...rows, task({ event: 'ended', taskId: 'b1', toolUseId: 'tu1', status: 'completed', summary: 'ok' }, 9000), live([], 9001)]);
        expect(done.ended.map((s) => [s.command, s.state, s.summary])).toEqual([['npm test', 'completed', 'ok']]);
        expect(done.unreported).toEqual([]);
    });

    it('the live set is authoritative: a task only the set names is running; a running task the set dropped without an ending is no longer running', () => {
        const s = agentShells([
            task({ event: 'started', taskId: 'b1', toolUseId: 'tu9', taskType: 'local_bash', description: 'watch logs' }, 10),
            live([{ taskId: 'b1', taskType: 'local_bash', description: 'watch logs' }, { taskId: 'a7', taskType: 'local_agent', description: 'research' }], 11),
            live([{ taskId: 'a7', taskType: 'local_agent', description: 'research' }], 20),
        ]);
        expect(s.running.map((x) => [x.key, x.kind])).toEqual([['a7', 'subagent']]);
        expect(s.ended.map((x) => [x.key, x.state])).toEqual([['b1', 'gone']]);
    });

    it('a new Claude process starts from NOTHING running: what ran before is marked gone, not still running', () => {
        const s = agentShells([
            bash('tu1', 'npm run dev', true, 1),
            task({ event: 'started', taskId: 'b1', toolUseId: 'tu1', taskType: 'local_bash', description: 'dev' }, 2),
            live([{ taskId: 'b1', taskType: 'local_bash', description: 'dev' }], 3),
            row({ kind: 'run', resumed: true }, 4),
        ]);
        expect(s.running).toHaveLength(0);
        expect(s.ended.map((x) => x.state)).toEqual(['gone']);
    });

    it('a command from an EARLIER process, never reported, is no longer tracked after the restart — not "not reported" forever', () => {
        const s = agentShells([bash('tu1', 'npm run dev', true, 1), row({ kind: 'run', resumed: true }, 5), bash('tu2', 'npm run watch', true, 6)]);
        expect(s.unreported.map((x) => x.command)).toEqual(['npm run watch']);
        expect(s.ended).toEqual([expect.objectContaining({ command: 'npm run dev', state: 'gone', endedAt: 5 })]);
    });

    it('with no task frames at all, a background command is listed as NOT REPORTED — not running, not finished', () => {
        const s = agentShells([bash('tu1', 'npm run dev', true, 1)]);
        expect(s.reported).toBe(false);
        expect(s.running).toHaveLength(0);
        expect(s.ended).toHaveLength(0);
        expect(s.unreported).toEqual([expect.objectContaining({ command: 'npm run dev', state: 'unreported' })]);
    });

    it('ambient tasks (Claude Code\'s own) are shown but not counted; killed is reported as stopped', () => {
        const s = agentShells([
            task({ event: 'started', taskId: 'm1', taskType: 'local_bash', description: 'watcher', ambient: true }, 1),
            task({ event: 'started', taskId: 'b2', taskType: 'local_bash', description: 'build' }, 2),
            live([{ taskId: 'm1', taskType: 'local_bash', description: 'watcher', ambient: true }, { taskId: 'b2', taskType: 'local_bash', description: 'build' }], 3),
            task({ event: 'updated', taskId: 'b2', patch: { status: 'killed', endTime: 9 } }, 9),
            live([{ taskId: 'm1', taskType: 'local_bash', description: 'watcher', ambient: true }], 10),
        ]);
        expect(s.running.map((x) => [x.key, x.ambient])).toEqual([['m1', true]]);
        expect(s.count).toBe(0);
        expect(s.ended.map((x) => [x.key, x.state])).toEqual([['b2', 'stopped']]);
    });

    it('terminals it opened through Genie are listed from its own manageTerminals calls', () => {
        const s = agentShells([
            wire({ sessionUpdate: 'tool_call', toolCallId: 'tm1', title: 'mcp__genie__manageTerminals', status: 'completed', rawInput: { action: 'create', command: 'php artisan serve' } }, 7),
            wire({ sessionUpdate: 'tool_call', toolCallId: 'tm2', title: 'mcp__genie__manageTerminals', status: 'completed', rawInput: { action: 'list' } }, 8),
        ]);
        expect(s.terminals).toEqual([{ key: 'tm1', command: 'php artisan serve', at: 7 }]);
    });

    it('the count is what the indicator shows: running, not ambient', () => {
        const s = agentShells([
            task({ event: 'started', taskId: 'b1', taskType: 'local_bash', description: 'a' }, 1),
            task({ event: 'started', taskId: 'b2', taskType: 'local_bash', description: 'b' }, 2),
            live([{ taskId: 'b1', taskType: 'local_bash', description: 'a' }, { taskId: 'b2', taskType: 'local_bash', description: 'b' }], 3),
        ]);
        expect(s.count).toBe(2);
    });
});
