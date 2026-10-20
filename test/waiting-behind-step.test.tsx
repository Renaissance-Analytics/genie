import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chatMessages, type ChatDetail } from '../src/core/chat-view.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { ChatWaiting } from '../src/renderer/components/ChatFlyout.js';

/**
 * A MESSAGE SENT WHILE THE AGENT IS IN A LONG STEP SAYS SO (beta.33 item 21). The owner (2026-10-20, screenshot): moic was
 * inside one shell command, "Run the correspondence and account settings tests", from 14:31; three messages sent between
 * 14:31 and 14:33 went unanswered, with nothing on screen saying why.
 *
 * Genie hands a prompt to Claude Code at once; Claude reads it at its next tool boundary. So a message sent while a tool
 * is running WAITS behind that step — and the chat now says so: which step, running since when. The owner's choice
 * (FTQ q_91b3cddf: BUTTON): `Interrupt and send` on it ends the current turn — the existing Stop-this-turn path — and the
 * waiting messages run next, in order. They are already with the provider (prism-acp's measurement, ClaudeDriver.cancel:
 * "a message queued on stdin at the moment of the interrupt still ran afterwards"), so nothing is sent twice.
 */
const T = Date.UTC(2026, 9, 20, 14, 31, 0);
const row = (id: string, event: StreamEvent, at: number): TimedEvent => ({ id, event, at });
const tool = (id: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', at: number, title = 'Run the correspondence and account settings tests'): TimedEvent =>
    row(id, { kind: 'tool', toolCallId: 'toolu_1', name: 'Bash', title, status, toolKind: 'execute', rawInput: null } as StreamEvent, at);
const you = (id: string, text: string, at: number): TimedEvent => row(id, { kind: 'message', speaker: 'you', peerName: null, text }, at);
const detail = (rows: TimedEvent[]): ChatDetail => ({ agent: { id: 'a1', name: 'moic', provider: 'claude', fidelity: 'declared' }, session: null, rows });
const waitingOf = (rows: TimedEvent[]) => Object.fromEntries(chatMessages(detail(rows)).filter((m) => m.who === 'you').map((m) => [m.id, m.waiting ?? null]));

describe('which messages wait, and behind what', () => {
    it('sent while a step runs: waiting behind that step, since it started — all three of the owner’s', () => {
        const rows = [
            row('t1', { kind: 'turn', n: 1, by: 'you' }, T - 60_000),
            you('m0', 'run the tests', T - 60_000),
            tool('c1', 'pending', T),
            tool('c2', 'in_progress', T + 1_000),
            you('m1', 'are you there?', T + 30_000),
            you('m2', 'hello?', T + 90_000),
            you('m3', 'stop and tell me', T + 120_000),
        ];
        const behind = { step: 'Run the correspondence and account settings tests', since: T };
        expect(waitingOf(rows)).toEqual({ m0: null, m1: behind, m2: behind, m3: behind });
    });

    it('the step finishing (or failing) is the boundary Claude reads them at: no longer waiting (positive control above)', () => {
        const base = [row('t1', { kind: 'turn', n: 1, by: 'you' }, T - 60_000), tool('c1', 'in_progress', T), you('m1', 'are you there?', T + 30_000)];
        expect(waitingOf([...base, tool('c2', 'completed', T + 200_000)])).toEqual({ m1: null });
        expect(waitingOf([...base, tool('c2', 'failed', T + 200_000)])).toEqual({ m1: null });
    });

    it('the turn ending or being stopped ends the wait; a message sent with no step running does not wait', () => {
        const base = [row('t1', { kind: 'turn', n: 1, by: 'you' }, T - 60_000), tool('c1', 'in_progress', T), you('m1', 'x', T + 30_000)];
        expect(waitingOf([...base, row('s', { kind: 'stopped', n: 1, by: 'you' }, T + 40_000)])).toEqual({ m1: null });
        expect(waitingOf([...base, row('t2', { kind: 'turn', n: 2, by: 'you' }, T + 40_000)])).toEqual({ m1: null });
        expect(waitingOf([row('t1', { kind: 'turn', n: 1, by: 'you' }, T), you('m1', 'x', T + 1)])).toEqual({ m1: null });
    });
});

type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const p = node.props as Props;
    if (match(p)) out.push(p);
    findAll(p.children, match, out);
    return out;
}

describe('on screen', () => {
    const waiting = { step: 'Run the correspondence and account settings tests', since: T };

    it('says it is waiting, behind which step, since when — and offers Interrupt and send', () => {
        const html = renderToStaticMarkup(ChatWaiting({ id: 'm1', agentName: 'moic', waiting, onInterruptAndSend: () => {} }));
        expect(html).toContain('data-chat-waiting="m1"');
        expect(html).toMatch(/Waiting — moic reads it when this step ends/);
        expect(html).toContain('Run the correspondence and account settings tests');
        expect(html).toMatch(/running since \d\d:\d\d/);
        let pressed = 0;
        const [b] = findAll(ChatWaiting({ id: 'm1', agentName: 'moic', waiting, onInterruptAndSend: () => { pressed += 1; } }), (p) => p['data-action'] === 'interrupt-and-send');
        (b!.onClick as () => void)();
        expect(pressed).toBe(1);
    });

    it('with no way to stop this turn here, it still says why — no dead button', () => {
        const html = renderToStaticMarkup(ChatWaiting({ id: 'm1', agentName: 'moic', waiting }));
        expect(html).toContain('data-chat-waiting="m1"');
        expect(html).not.toContain('interrupt-and-send');
    });
});

describe('the genie skill', () => {
    it('tells agents to run long commands in the background, so their steps stay short and messages reach them', () => {
        const genie = GENIE_SKILLS.find((s) => s.name === 'genie')!.body;
        expect(genie).toMatch(/test suites?, builds?.*background/i);
        expect(genie).toMatch(/messages? (from the person )?reach(es)? you/i);
    });
});
