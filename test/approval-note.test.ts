import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { approvalNoteText } from '../src/core/approval-note.js';
import type { DeckItem } from '../src/core/deck.js';
import { deckAnswerRoute, resolveDeckAnswer } from '../src/core/deck-resolve.js';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore } from '../src/core/thread-store.js';

/**
 * A REJECTION'S NOTE REACHES THE AGENT (beta.33 item 16). The owner (2026-10-20): "compass proposed a file edit but I
 * rejected with a note in the rejection but compass did not get the rejection notice, it just discarded the file edits
 * and compass was never made aware." Measured: a provider approval was answered with the option alone
 * (`answer-provider-approval { agentId, optionId }`, `answerApproval(agentId, optionId)` end to end) — ACP's permission
 * outcome has no note field, and Genie sent the note no other way.
 *
 * Now every approval takes an optional note, and after the answer Genie delivers it to that agent as a message — "You
 * rejected <what>: <note>", or approved with a note — through the same path a chat prompt takes (Claude reads it at its
 * next step). A provider that refuses a prompt mid-turn (Codex) gets it the moment the turn ends. No note, no message.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function open(opts: { refusesMidTurn?: boolean } = {}) {
    let events: DriverEvents = {};
    const prompts: string[] = [];
    let inTurn = false;
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = {
            start: () => {},
            prompt: (content) => {
                // prism-acp's CodexDriver refuses a second prompt while a turn runs.
                if (opts.refusesMidTurn && inTurn) throw new Error('Codex turn already in flight');
                inTurn = true;
                prompts.push(String(content));
            },
            kill: () => {}, get running() { return true; }, get cliSessionId() { return null; },
        };
        return driver;
    };
    const dir = mkdtempSync(join(tmpdir(), 'genie2-approval-note-'));
    dirs.push(dir);
    const rows: StreamEvent[] = [];
    const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: noProcessTree, onEvent: (e) => { rows.push(e); } });
    session.start();
    // A turn running, as when a provider asks: the person's prompt started it.
    session.prompt('edit the config', 'you');
    const ask = () => events.onRequestPermission?.({ toolCall: { title: 'Edit src/config.ts', kind: 'edit' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }] });
    const endTurn = () => { inTurn = false; events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }); };
    return { session, rows, prompts, ask, endTurn };
}

describe('the words', () => {
    it('"You rejected <what>: <note>", approved with a note, or answered with the option — and nothing without a note', () => {
        expect(approvalNoteText({ what: 'Edit src/config.ts', outcome: 'denied', option: 'Reject', note: 'use the .env instead' })).toBe('You rejected Edit src/config.ts: use the .env instead');
        expect(approvalNoteText({ what: 'Edit src/config.ts', outcome: 'allowed', option: 'Allow', note: ' keep the comments ' })).toBe('You approved Edit src/config.ts, with a note: keep the comments');
        expect(approvalNoteText({ what: 'Edit src/config.ts', outcome: 'answered', option: 'Always allow', note: 'fine' })).toBe('You answered "Always allow" to Edit src/config.ts: fine');
        expect(approvalNoteText({ what: 'Edit src/config.ts', outcome: 'denied', option: 'Reject', note: '   ' })).toBeNull();
    });
});

describe('the session delivers the note', () => {
    it('a rejection with a note: the provider is answered, then the agent is told — as your message, in the ledger', () => {
        const s = open();
        void s.ask();
        expect(s.session.answerApproval('deny', 'use the .env instead')).toBe(true);
        expect(s.prompts).toEqual(['edit the config', 'You rejected Edit src/config.ts: use the .env instead']);
        const mine = s.rows.filter((r) => r.kind === 'message' && r.speaker === 'you').map((r) => (r.kind === 'message' ? r.text : ''));
        expect(mine).toEqual(['edit the config', 'You rejected Edit src/config.ts: use the .env instead']);
        // The decision's own row keeps the note.
        expect(s.rows.filter((r) => r.kind === 'approval')).toEqual([{ kind: 'approval', question: 'Edit src/config.ts', tool: null, outcome: 'denied', optionId: 'deny', note: 'use the .env instead' }]);
    });

    it('no note: the provider is answered and nothing more is sent (positive control: the same answer with a note sends one)', () => {
        const s = open();
        void s.ask();
        s.session.answerApproval('deny');
        expect(s.prompts).toEqual(['edit the config']);
        expect(s.rows.filter((r) => r.kind === 'approval')).toEqual([{ kind: 'approval', question: 'Edit src/config.ts', tool: null, outcome: 'denied', optionId: 'deny' }]);
    });

    it('a provider that refuses a prompt mid-turn (Codex) gets the note when the turn ends — once, nothing lost', () => {
        const s = open({ refusesMidTurn: true });
        void s.ask();
        expect(s.session.answerApproval('allow', 'keep the comments')).toBe(true);
        expect(s.prompts).toEqual(['edit the config']);
        s.endTurn();
        expect(s.prompts).toEqual(['edit the config', 'You approved Edit src/config.ts, with a note: keep the comments']);
        s.endTurn();
        expect(s.prompts).toHaveLength(2);
    });
});

describe('the Deck carries the note', () => {
    const item = (id: string, over: Partial<DeckItem> = {}): DeckItem => ({
        id, source: 'agent-question', agentId: 'agent_compass', agentName: 'compass', workspaceId: 'tynn', title: 'compass wants to open a terminal: npm test',
        blocking: true, priority: 'high', at: 1, answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] }, forwardedFrom: null, ...over,
    } as DeckItem);

    it('a provider approval answered on the Deck goes to the session WITH its note', () => {
        expect(deckAnswerRoute(item('approval:agent_compass'), 'deny', 'not that file')).toEqual({ kind: 'provider', agentId: 'agent_compass', optionId: 'deny', note: 'not that file' });
        expect(deckAnswerRoute(item('approval:agent_compass'), 'deny')).toEqual({ kind: 'provider', agentId: 'agent_compass', optionId: 'deny', note: '' });
    });

    it('a Genie approval (`appr_`) and a one-click question keep the note too', () => {
        expect(resolveDeckAnswer(item('appr_1_1'), 'deny', 'run it in the background')).toEqual({ kind: 'resolve-approval', approvalId: 'appr_1_1', choice: 'deny', note: 'run it in the background' });
        expect(resolveDeckAnswer(item('q_1', { answer: { kind: 'inline', options: [{ id: 'Yes', label: 'Yes', tone: 'neutral' }] } }), 'Yes', 'after lunch')).toMatchObject({ kind: 'answer-question', note: 'after lunch' });
    });
});
