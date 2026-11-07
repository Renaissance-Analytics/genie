import { describe, expect, it } from 'vitest';
import { BackgroundCount } from '../src/core/background-count.js';
import { statePill } from '../src/core/agent-view.js';
import { chatContext } from '../src/core/chat-view.js';
import { groupByStatus, groupByWorkspace, statusOf, summaryChips, type AgentRow } from '../src/core/dashboard-view.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';
import { toStreamEvent, type StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * AN AGENT WITH WORK STILL RUNNING IN THE BACKGROUND DOES NOT READ IDLE (the owner, 2026-10-21, a screenshot of tynn
 * reading "Idle" while its Shells tab listed what it had running: "we still have the bug where an agent that is doing
 * something like what you are doing shows as idle … this should be fixed in the next release").
 *
 * Its turn has ended, but the background shells and tasks it started are running — Claude's own task notices say so,
 * and the Shells tab already lists them (core/agent-shells.ts). The header, the Dashboard and the chat now say
 * Working · N in the background. The count is KEPT, re-read only when a row that can change it arrives, so a busy agent's
 * every event costs nothing more (test/agent-stream-perf.test.ts holds that).
 */

const live = (over: Partial<LiveSession>): LiveSession => ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...over } as LiveSession);
const record = { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'ws' } as never;
function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'ws', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over };
}

describe('wherever the agent is seen', () => {
    it('the header reads Working · N in the background, not Idle', () => {
        expect(statePill(live({ background: 2 }), () => 0)).toMatchObject({ word: 'Working · 2 in the background', tone: 'ok' });
        expect(statePill(live({ background: 1 }), () => 0).word).toBe('Working · 1 in the background');
    });

    it('the Dashboard row reads Working, with what is running; the chat line says the same', () => {
        expect(agentRowFor(record, live({ background: 3 }), () => 2).background).toBe(3);
        expect(statusOf(row({ background: 3 }))).toEqual({ word: 'Working', detail: '3 in the background', tone: 'ok' });
        expect(chatContext({ agent: { fidelity: 'declared', provider: 'claude' }, session: live({ background: 1 }), rows: [] } as never)).toEqual({ text: 'Working · 1 in the background', tone: 'ok' });
    });

    it('CONTROL: nothing in the background is Idle as before; a question waiting on you still comes first', () => {
        expect(statePill(live({ background: 0 }), () => 0).word).not.toMatch(/background/);
        expect(statusOf(row({ background: 0 })).word).toBe('Idle');
        expect(statusOf(row({ background: 2, state: 'waiting', ask: 'Run it?' })).word).toBe('Waiting on you');
    });
});

/**
 * "AN AGENT THAT IS WORKING IN THE BACKGROUND IS NOT AN IDLE AGENT, JUST AN IDLE CHAT" (the owner, genie#1528): the row read
 * `Working · 5 in the background` under the Idle heading, and the header counted it idle. `row.state` stays `idle`, because
 * its chat IS idle and takes a prompt or mail at once: only how the board groups, counts and orders the row changes.
 */
describe('the board groups, counts and orders it as Working', () => {
    const grouped = (rows: readonly AgentRow[]) => groupByStatus(rows).map((g) => [g.label, g.rows.map((r) => r.id)]);
    const chips = (rows: readonly AgentRow[]) => summaryChips(rows).map((c) => c.label);
    const bg = row({ id: 'bg', background: 5 });
    const quiet = row({ id: 'quiet' });
    const busy = row({ id: 'busy', state: 'working' });

    it('in the Working group, in the order given', () => {
        expect(grouped([quiet, bg, busy])).toEqual([['Working', ['bg', 'busy']], ['Idle', ['quiet']]]);
    });

    it('counted as working in the header, never as idle', () => {
        expect(chips([quiet, bg, busy])).toEqual(['2 working', '1 idle']);
        expect(chips([bg])).toEqual(['1 working']);
    });

    it('By workspace: ordered with Working too, ahead of the idle rows', () => {
        expect(groupByWorkspace([quiet, bg, busy], ['ws'])[0]!.rows.map((r) => r.id)).toEqual(['bg', 'busy', 'quiet']);
    });

    it('CONTROL: a count of 0, or none reported, is Idle: word, group and chip', () => {
        for (const background of [0, null, undefined]) {
            const r = row({ id: 'r', background });
            expect(statusOf(r).word).toBe('Idle');
            expect(grouped([r])).toEqual([['Idle', ['r']]]);
            expect(chips([r])).toEqual(['1 idle']);
        }
    });

    it('CONTROL: an unstarted agent is Stopped; a running idle session is Idle', () => {
        expect(grouped([agentRowFor(record, null, () => 2)])).toEqual([['Stopped', ['a1']]]);
        expect(grouped([agentRowFor(record, live({ background: 0 }), () => 2)])).toEqual([['Idle', ['a1']]]);
    });

    it('CONTROL: what already outranks it keeps its place: waiting, broken, and Cooling (with Working, as ever)', () => {
        const waiting = row({ id: 'waiting', state: 'waiting', ask: 'Run it?', background: 2 });
        const broken = row({ id: 'broken', state: 'broken', reason: 'gone', background: 2 });
        const cooling = row({ id: 'cooling', state: 'cooling' });
        const coolingBg = row({ id: 'coolingBg', state: 'cooling', background: 2 });
        const rows = [waiting, broken, cooling, coolingBg];
        expect(grouped(rows)).toEqual([['Waiting on you', ['waiting']], ['Broken', ['broken']], ['Working', ['cooling', 'coolingBg']]]);
        expect(chips(rows)).toEqual(['1 waiting on you', '1 broken', '2 working']);
        expect(statusOf(cooling)).toEqual({ word: 'Cooling', detail: null, tone: 'cool' });
    });

    it('CONTROL: only a declared agent: an observed row stays Quiet and a remote one Unreachable, grouped as they read', () => {
        const observed = row({ id: 'observed', fidelity: 'observed', background: 3 });
        const remote = row({ id: 'remote', fidelity: 'remote', background: 3 });
        expect(statusOf(observed).word).toBe('Quiet');
        expect(statusOf(remote).word).toBe('Unreachable');
        expect(grouped([observed, remote])).toEqual([['Idle', ['observed', 'remote']]]);
        expect(chips([observed])).toEqual(['1 idle']);
    });

    it('a stopped process runs nothing: its last count is not work (the header and the chat already ask `running`)', () => {
        const r = agentRowFor(record, live({ running: false, background: 3 }), () => 2);
        expect(r.background).toBeNull();
        expect(statusOf(r).word).toBe('Stopped');
        expect(grouped([r])).toEqual([['Stopped', ['a1']]]);
    });

    it('its STATE stays idle: what reads the state for behaviour sees what it saw', () => {
        expect(agentRowFor(record, live({ background: 3 }), () => 2).state).toBe('idle');
    });
});

let n = 0;
const at = (event: StreamEvent): TimedEvent => ({ id: `r${++n}`, event, at: n });
const wire = (update: Record<string, unknown>) => at(toStreamEvent(update)!);
const bash = (id: string, command: string) => wire({ sessionUpdate: 'tool_call', toolCallId: id, title: command, kind: 'execute', status: 'completed', rawInput: { command, run_in_background: true } });
const task = (payload: Record<string, unknown>) => wire({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'task' }, _meta: { 'particle.academy/task': payload } });
const tool = (id: string) => wire({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Read', kind: 'read', status: 'completed', rawInput: { file_path: '/x' } });

describe('the kept count', () => {
    it('follows Claude’s task notices: started → 1, ended → 0', () => {
        const rows: TimedEvent[] = [];
        const c = new BackgroundCount();
        const add = (r: TimedEvent) => { rows.push(r); c.changed(r.event); };
        add(bash('tu1', 'npm test'));
        add(task({ event: 'started', taskId: 'b1', toolUseId: 'tu1', taskType: 'local_bash', description: 'tests' }));
        expect(c.count(rows)).toBe(1);
        add(task({ event: 'ended', taskId: 'b1', toolUseId: 'tu1', status: 'completed' }));
        expect(c.count(rows)).toBe(0);
    });

    it('re-reads the ledger ONLY when a row that can change it arrives (COUNTED: ordinary tool rows never rescan)', () => {
        const rows: TimedEvent[] = [];
        const c = new BackgroundCount();
        const add = (r: TimedEvent) => { rows.push(r); c.changed(r.event); };
        add(task({ event: 'started', taskId: 'b1', toolUseId: null, taskType: 'local_bash', description: 'x' }));
        expect(c.count(rows)).toBe(1);
        const before = c.scans;
        for (let i = 0; i < 200; i += 1) { add(tool(`t${i}`)); expect(c.count(rows)).toBe(1); }
        expect(c.scans).toBe(before);
        add(task({ event: 'ended', taskId: 'b1', toolUseId: null, status: 'completed' }));
        expect(c.count(rows)).toBe(0);
        expect(c.scans).toBe(before + 1);
    });
});
