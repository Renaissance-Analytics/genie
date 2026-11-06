import { describe, expect, it } from 'vitest';
import * as agentOps from '../src/core/agent-ops.js';
import type { StreamEvent } from '../src/core/stream-event.js';

/**
 * WHAT COMES WITH AN AGENT TO ANOTHER PROVIDER (Tynn story #380). The owner: "We dropped tui as a t1 model, it's just the
 * acp over cli and I should be able to switch providers and models without losing context."
 *
 * A switch used to start the agent on a NEW conversation with nothing of the old one. Now the new provider's first prompt
 * carries a CARRY-OVER built from Genie's own ledger: the person's and the agent's messages in order, each tool call as
 * one line (never its output), newest last, at most the last 40 turns and 24,000 characters — the cap and what it cut said
 * at the top — then the agent's current plan. Headed "Conversation so far, from <provider>:".
 *
 * The module is loaded by a computed path ON PURPOSE: before it exists these are red by assertion, not by an import error.
 */
const CARRY_MODULE = '../src/core/carry-over.js';
const carryModule: Record<string, unknown> = await import(/* @vite-ignore */ CARRY_MODULE).catch(() => ({}));
type Row = { event: StreamEvent; at: number | null };
type Built = { text: string; from: string; turns: number; of: number; plan: boolean };
type Build = (input: Record<string, unknown>) => Built | null;
const build = (input: Record<string, unknown>): Built | null => {
    const fn = carryModule['buildCarryOver'] as Build | undefined;
    expect(fn, 'buildCarryOver in core/carry-over.ts').toBeTypeOf('function');
    return fn!(input);
};

let t = 0;
const turn = (n: number, by: string | null = 'you'): Row => ({ event: { kind: 'turn', n, by }, at: ++t });
const you = (text: string): Row => ({ event: { kind: 'message', speaker: 'you', peerName: null, text }, at: ++t });
const agent = (text: string): Row => ({ event: { kind: 'message', speaker: 'agent', peerName: null, text }, at: ++t });
const peer = (from: string, text: string): Row => ({ event: { kind: 'message', speaker: 'peer', peerName: from, text }, at: ++t });
const tool = (id: string, title: string, status: string, output = 'RAW-OUTPUT-SHOULD-NOT-APPEAR'): Row =>
    ({ event: { kind: 'tool', toolCallId: id, name: 'Bash', title, status, toolKind: 'execute', rawInput: { command: 'secret-input' }, output } as unknown as StreamEvent, at: ++t });
const think = (text: string): Row => ({ event: { kind: 'think', text, tokens: null } as unknown as StreamEvent, at: ++t });

const base = { from: 'claude', to: 'codex', agentName: 'atlas', plan: [], since: null };

describe('the carry-over builder', () => {
    it('is headed, keeps messages in order newest last, and says each tool call in one line without its output or input', () => {
        const rows = [turn(1), you('Fix the login bug'), think('hmm, private thought'), tool('t1', 'Read src/login.ts', 'pending'), tool('t1', 'Read src/login.ts', 'completed'), agent('Found it: the token is never refreshed.'), peer('kai', 'FYI the API moved'), turn(2), you('Ship it'), agent('Done.')];
        const c = build({ ...base, rows })!;
        expect(c.text.startsWith('Conversation so far, from claude:')).toBe(true);
        const order = ['Fix the login bug', 'Read src/login.ts', 'Found it: the token is never refreshed.', 'FYI the API moved', 'Ship it', 'Done.'].map((s) => c.text.indexOf(s));
        expect(order.every((at) => at > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // One line per tool call, its last status — never the output, the input, or the thinking.
        expect(c.text.split('\n').filter((l) => l.includes('Read src/login.ts'))).toEqual([expect.stringMatching(/Read src\/login\.ts.*completed/)]);
        expect(c.text).not.toContain('RAW-OUTPUT-SHOULD-NOT-APPEAR');
        expect(c.text).not.toContain('secret-input');
        expect(c.text).not.toContain('private thought');
        // Who said what.
        expect(c.text).toMatch(/Person: Fix the login bug/);
        expect(c.text).toMatch(/atlas: Found it/);
        expect(c.text).toMatch(/kai: FYI the API moved/);
        expect(c).toMatchObject({ from: 'claude', turns: 2, of: 2, plan: false });
    });

    it('caps at the last 40 turns and says so, with how many were left out (COUNTED)', () => {
        const rows: Row[] = [];
        for (let n = 1; n <= 55; n += 1) rows.push(turn(n), you(`question ${n}`), agent(`answer ${n}`));
        const c = build({ ...base, rows })!;
        expect(c).toMatchObject({ turns: 40, of: 55 });
        expect(c.text).not.toContain('question 15\n');
        expect(c.text).toContain('question 16');
        expect(c.text).toContain('answer 55');
        const head = c.text.split('\n').slice(0, 4).join('\n');
        expect(head).toMatch(/last 40 of 55 turns/);
        expect(head).toMatch(/15 earlier turns? (were|was) left out/);
    });

    it('caps at 24,000 characters, dropping the OLDEST turns first, and says so', () => {
        const rows: Row[] = [];
        for (let n = 1; n <= 10; n += 1) rows.push(turn(n), you(`q${n} ${'x'.repeat(5000)}`));
        const c = build({ ...base, rows })!;
        expect(c.text.length).toBeLessThanOrEqual(24_000);
        expect(c.text).toContain('q10 ');
        expect(c.text).not.toContain('q1 ');
        expect(c.turns).toBeLessThan(10);
        expect(c.of).toBe(10);
        expect(c.text.split('\n').slice(0, 4).join('\n')).toMatch(/24,000 characters/);
    });

    it('carries the current plan after the conversation', () => {
        const c = build({ ...base, rows: [turn(1), you('go')], plan: [{ content: 'Write the test', status: 'completed' }, { content: 'Make it pass', status: 'in_progress' }] })!;
        expect(c.plan).toBe(true);
        expect(c.text.indexOf('Make it pass')).toBeGreaterThan(c.text.indexOf('go'));
        expect(c.text).toMatch(/in_progress.*Make it pass|Make it pass.*in_progress/);
    });

    it('only what happened since `since` (switching back carries only the other provider’s part)', () => {
        const rows = [turn(1), you('before'), agent('old reply'), turn(2), you('after'), agent('new reply')];
        const since = rows[3]!.at! - 0.5;
        const c = build({ ...base, rows, since })!;
        expect(c.text).toContain('after');
        expect(c.text).not.toContain('before');
        expect(c).toMatchObject({ turns: 1, of: 1 });
    });

    it('never carries an earlier carry-over (no nesting), and nothing to carry is null', () => {
        const marker: Row = { event: { kind: 'notice', level: 'info', message: 'Context carried from codex (3 turns)', carried: { from: 'codex', turns: 3, text: 'Conversation so far, from codex: OLD' } } as unknown as StreamEvent, at: ++t };
        const c = build({ ...base, rows: [turn(1), marker, you('hello')] })!;
        expect(c.text).not.toContain('OLD');
        expect(build({ ...base, rows: [] })).toBeNull();
    });

    it('unicode is never cut in half: a cap through an emoji or CJK keeps whole characters', () => {
        const rows: Row[] = [];
        for (let n = 1; n <= 3; n += 1) rows.push(turn(n), you(`${n} ${'🧞語'.repeat(9000)}`));
        const c = build({ ...base, rows })!;
        expect(c.text.length).toBeLessThanOrEqual(24_000);
        // No lone surrogate anywhere.
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c.text)).toBe(false);
        expect(c.text).toContain('🧞語');
    });
});

describe('what the person is told after a switch', () => {
    const outcome = (agentOps as Record<string, unknown>)['switchOutcome'] as (name: string, d: unknown) => string;

    it('the conversation comes with it, and switching back resumes the old one — no AGENT.md, no "new conversation"', () => {
        const said = outcome('atlas', { ok: true, from: 'claude', to: 'codex', carried: { turns: 12, of: 12, plan: true }, left: 'sess-1', droppedModel: null });
        expect(said).toBe('atlas switched claude → codex. Its conversation comes with it (the last 12 turns and its plan). Switching back to claude resumes its claude conversation.');
        expect(said).not.toMatch(/new conversation|AGENT\.md|tuis/i);
    });

    it('when the carry-over had to cut, it says how much', () => {
        expect(outcome('atlas', { ok: true, from: 'claude', to: 'codex', carried: { turns: 40, of: 55, plan: false }, left: 'sess-1', droppedModel: null }))
            .toBe('atlas switched claude → codex. Its conversation comes with it (the last 40 of 55 turns). Switching back to claude resumes its claude conversation.');
    });
});
