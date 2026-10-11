import { describe, expect, it } from 'vitest';
import { deckBand } from '../src/core/deck.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * THE APPROVAL QUEUE — the gate behind `manageTerminals create/write` (and any other tool that
 * must not act until a person says so). A request parks as a BLOCKING Deck item answered inline
 * with Allow / Deny; the caller's promise resolves with the verdict. An abandoned request is
 * cancelled, never silently allowed; a request Genie restarts under is lost and the agent is told
 * so, because a verdict nobody gave is not a verdict.
 */

const atlas: Caller = { agentId: 'agent_' + 'a'.repeat(32) as Caller['agentId'], agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' };
let clock = 1_000;
const now = () => clock++;

describe('asking', () => {
    it('parks a request as a blocking Deck item with Allow / Deny, and the gate promise stays pending', async () => {
        const q = new ApprovalQueue({ now });
        let settled: string | null = null;
        const verdict = q.gate(atlas, 'write', 'rm -rf build').then((v) => { settled = v; return v; });
        await Promise.resolve();
        expect(settled).toBeNull();
        const items = q.deckItems();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ source: 'agent-question', agentId: atlas.agentId, agentName: 'atlas', workspaceId: 'tynn', blocking: true, priority: 'high', title: 'atlas wants to write to a terminal: rm -rf build', forwardedFrom: null });
        expect(items[0]!.answer).toEqual({ kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] });
        q.resolve(items[0]!.id, 'allow');
        expect(await verdict).toBe('allowed');
        expect(q.deckItems()).toEqual([]);
    });

    it('deny resolves denied; an unknown or already-answered id is refused — a verdict cannot be given twice', async () => {
        const q = new ApprovalQueue({ now });
        const verdict = q.gate(atlas, 'create', 'npm test');
        const id = q.deckItems()[0]!.id;
        expect(q.resolve(id, 'deny')).toBe(true);
        expect(await verdict).toBe('denied');
        expect(q.resolve(id, 'allow')).toBe(false);
        expect(q.resolve('appr_nope', 'allow')).toBe(false);
    });

    it('the same agent asking the same thing twice while the first is pending gets ONE item and both callers get the one verdict', async () => {
        const q = new ApprovalQueue({ now });
        const a = q.gate(atlas, 'write', 'ls');
        const b = q.gate(atlas, 'write', 'ls');
        expect(q.deckItems()).toHaveLength(1);
        q.resolve(q.deckItems()[0]!.id, 'allow');
        expect(await Promise.all([a, b])).toEqual(['allowed', 'allowed']);
    });

    it('ranks with the rest of the Deck: a pending approval is blocking and high, so it sits above a normal question', () => {
        const q = new ApprovalQueue({ now });
        void q.gate(atlas, 'create', 'x');
        const band = deckBand([
            { id: 'q_1', source: 'agent-question', agentId: 'agent_b', agentName: 'kai', workspaceId: 'tynn', title: 'Which?', blocking: true, priority: 'normal', at: 0, answer: { kind: 'form', fields: 1 }, forwardedFrom: null },
            ...q.deckItems(),
        ]);
        expect(band[0]!.id).toMatch(/^appr_/);
    });
});

describe('abandonment', () => {
    it('cancelAll resolves every pending request as denied with the reason, for a quit or a hibernate', async () => {
        const q = new ApprovalQueue({ now });
        const a = q.gate(atlas, 'write', 'one');
        const b = q.gate(atlas, 'create', 'two');
        q.cancelAll('Genie is shutting down');
        expect(await Promise.all([a, b])).toEqual(['denied', 'denied']);
        expect(q.deckItems()).toEqual([]);
        expect(q.lastCancelled()).toEqual([{ action: 'write', detail: 'one', reason: 'Genie is shutting down' }, { action: 'create', detail: 'two', reason: 'Genie is shutting down' }]);
    });

    it('a request older than the timeout is denied as abandoned, by `sweep`, never silently allowed', async () => {
        const q = new ApprovalQueue({ now, timeoutMs: 100 });
        const v = q.gate(atlas, 'write', 'late');
        clock += 1_000;
        expect(q.sweep()).toBe(1);
        expect(await v).toBe('denied');
        expect(q.deckItems()).toEqual([]);
    });
});
