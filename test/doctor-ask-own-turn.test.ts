import { describe, expect, it } from 'vitest';
import type { AgentId } from '../src/core/identity.js';
import { askAndWait, type OsaHostLike } from '../src/main/doctor-mcp.js';

/**
 * `ask` RETURNS THE ANSWER TO ITS OWN QUESTION. Measured in doctor trial 4 on the owner's machine (2026-10-13): the first
 * `ask` came back with genie's reply to the channel's announcement, the second with the answer to the FIRST question.
 * `ask` waited for genie to be idle — but a prompt sent while genie is mid-turn queues, and the earlier turn's end reads
 * as idle. Every prompt lays a `turn` marker and the session counts finished turns, so a question is the N-th turn where
 * N is the number of markers once it is sent: `ask` is done when N turns have finished, and its reply is the agent's
 * words after its own marker.
 */
type Row = { id: string; event: { kind: string; speaker?: string; text?: string }; at: number | null };

function fakeHost() {
    const rows: Row[] = [];
    let turns = 0;
    let state: 'idle' | 'working' = 'idle';
    const listeners = new Set<(id: AgentId) => void>();
    const emit = () => { for (const l of listeners) l('osa' as AgentId); };
    const host: OsaHostLike = {
        prompt: (_id, text) => {
            rows.push({ id: `t${rows.length}`, event: { kind: 'turn' }, at: 1 });
            rows.push({ id: `p${rows.length}`, event: { kind: 'message', speaker: 'you', text }, at: 1 });
            state = 'working';
            return true;
        },
        rowsFor: () => rows as never,
        probe: () => ({ running: true, turnState: state }) as never,
        subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
        turnsFor: () => turns,
    };
    // The provider finishes the oldest open turn with these words (and goes idle, as the session does between queued turns).
    const finishTurn = (words: string) => {
        rows.push({ id: `a${rows.length}`, event: { kind: 'message', speaker: 'agent', text: words }, at: 2 });
        turns += 1;
        state = 'idle';
        emit();
    };
    return { host, finishTurn };
}

describe('ask over queued turns', () => {
    it('a question sent while an earlier turn runs waits for ITS turn, and returns its own answer', async () => {
        const { host, finishTurn } = fakeHost();
        host.prompt('osa' as AgentId, 'the announcement');          // turn 1, in flight
        let settled = false;
        const pending = askAndWait(host, 'osa', 'what is the name of your skill?', 2_000).then((r) => { settled = true; return r; });
        finishTurn('I am ready.');                                    // turn 1 ends: not this question's
        await new Promise((r) => setTimeout(r, 10));
        expect(settled).toBe(false);
        finishTurn('It is called genie-diagnostics.');                // turn 2 ends: this question's
        expect(await pending).toEqual({ ok: true, reply: 'It is called genie-diagnostics.' });
    });

    it('with nothing in flight it resolves on its own turn (positive control: the same host, no earlier turn)', async () => {
        const { host, finishTurn } = fakeHost();
        const pending = askAndWait(host, 'osa', 'which folder?', 2_000);
        finishTurn('In genie2-doctor/osa.');
        expect(await pending).toEqual({ ok: true, reply: 'In genie2-doctor/osa.' });
    });
});
