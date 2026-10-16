import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore } from '../src/core/thread-store.js';

/**
 * A TURN THE AGENT STARTED ITSELF IS A TURN (the owner, 2026-10-14, with a screenshot: "You are still working and yet the
 * ui says you are idle. and no green light"). The session set `working` only when Genie sent a prompt. Claude Code also
 * starts turns on its own — a background task finished, a subagent reported — and those ran under "Idle". Worse: at
 * quit Genie cancels only the turns it believes are running, so such a turn was killed mid-flight and came back as
 * "The turn did not finish, and the provider gave no reason."
 *
 * Rule: once a turn has ENDED (idle), the agent's own activity — a reply, a thought, a tool call — opens a turn: a
 * marker in the ledger (nobody prompted it, so `by: null`) and `working` until it ends. What trails a turn's end (a
 * usage report, a debug notice) opens nothing.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
const noTree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-selfturn-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
        return driver;
    };
    const rows: StreamEvent[] = [];
    const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: noTree, onEvent: (e) => { rows.push(e); } });
    session.start();
    return {
        session,
        rows,
        emit: (u: Record<string, unknown>) => events.onUpdate?.(u),
        end: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null } as never),
        turns: () => rows.filter((r) => r.kind === 'turn').map((r) => (r as { n: number; by: string | null })),
    };
}
const say = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const tool = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Bash', status: 'in_progress' });

describe('a turn the agent starts itself', () => {
    it('after a turn ended, the agent replying opens a turn: working, and a marker with nobody as its author', () => {
        const s = open();
        s.session.prompt('hello', 'you');
        s.emit(say('hi'));
        s.end();
        expect(s.session.turnState).toBe('idle');

        // Claude Code wakes itself (a background task finished) and works — nobody prompted it.
        s.emit(tool('t1'));
        expect(s.session.turnState).toBe('working');
        // COUNTED: two turns — yours, then the one it started itself.
        expect(s.turns()).toEqual([{ kind: 'turn', n: 1, by: 'you' }, { kind: 'turn', n: 2, by: null }]);

        s.emit(say('done'));
        expect(s.turns()).toHaveLength(2); // one marker per turn, not per frame
        s.end();
        expect(s.session.turnState).toBe('idle');
    });

    it('a thought opens it too', () => {
        const s = open();
        s.session.prompt('go', 'you');
        s.end();
        s.emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
        expect(s.session.turnState).toBe('working');
    });

    it('what trails a turn’s end opens nothing: a usage report and a debug notice leave it idle (the control)', () => {
        const s = open();
        s.session.prompt('go', 'you');
        s.end();
        s.emit({ sessionUpdate: 'usage_update', used: 10, size: 100 });
        s.emit({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'background tasks' }, _meta: { 'particle.academy/background_tasks': [] } });
        expect(s.session.turnState).toBe('idle');
        expect(s.turns()).toHaveLength(1);
    });
});
