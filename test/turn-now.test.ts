import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { turnNow } from '../src/core/turn-now.js';

/**
 * WHAT AN AGENT IS DOING NOW, FOR THE WORKSPACE DASHBOARD (the owner, 2026-10-19, approved in q_09d1f4a0: a card per
 * running or waiting agent — what it was asked, the tool it is in now, its plan step, how long). Read from the agent's
 * own rows: the prompt is the latest message that STARTED a turn (yours or a peer's), the tool is a call of THIS turn
 * that has not finished. Nothing reported = `null`, never a guess.
 */

let n = 0;
const at = (event: StreamEvent, t: number | null = 1_000): TimedEvent => ({ id: `r${(n += 1)}`, event, at: t });
const you = (text: string, t?: number) => at({ kind: 'message', speaker: 'you', peerName: null, text }, t);
const peer = (name: string, text: string) => at({ kind: 'message', speaker: 'peer', peerName: name, text });
const said = (text: string) => at({ kind: 'message', speaker: 'agent', peerName: null, text });
const tool = (id: string, over: Partial<Extract<StreamEvent, { kind: 'tool' }>> = {}, t?: number) =>
    at({ kind: 'tool', toolCallId: id, name: 'Bash', title: null, status: null, toolKind: null, rawInput: null, ...over }, t);

describe('turnNow', () => {
    it("the prompt: the latest message that started a turn, first line only; a peer's counts, the agent's own does not", () => {
        expect(turnNow([you('Fix the drawer\n\nmore detail'), said('On it')]).prompt).toBe('Fix the drawer');
        expect(turnNow([you('old'), peer('atlas', 'Review #990 please')]).prompt).toBe('Review #990 please');
        expect(turnNow([said('hello')]).prompt).toBeNull();
    });

    it("the tool: THIS turn's call still running, by its title, else its name", () => {
        const rows = [you('go'), tool('t1', { title: 'npm test', status: 'in_progress' })];
        expect(turnNow(rows).tool).toBe('npm test');
        expect(turnNow([you('go'), tool('t2', { name: 'Edit', status: 'pending' })]).tool).toBe('Edit');
    });

    it('a call that finished (its update says completed or failed) is not the tool it is in', () => {
        const rows = [you('go'), tool('t1', { title: 'npm test', status: 'in_progress' }), tool('t1', { title: null, status: 'completed' })];
        expect(turnNow(rows).tool).toBeNull();
        expect(turnNow([you('go'), tool('t3', { title: 'x', status: 'failed' })]).tool).toBeNull();
    });

    it('CONTROL: a call left open in an EARLIER turn is not the tool it is in now', () => {
        const rows = [you('first'), tool('t1', { title: 'stuck', status: 'in_progress' }), you('second')];
        expect(turnNow(rows).tool).toBeNull();
        expect(turnNow(rows).prompt).toBe('second');
    });

    it('a call with no status reported is not claimed to be running (null is not pending)', () => {
        expect(turnNow([you('go'), tool('t1', { title: 'x' })]).tool).toBeNull();
    });

    it('several open calls: the newest', () => {
        const rows = [you('go'), tool('a', { title: 'first', status: 'in_progress' }), tool('b', { title: 'second', status: 'in_progress' })];
        expect(turnNow(rows).tool).toBe('second');
    });
});
