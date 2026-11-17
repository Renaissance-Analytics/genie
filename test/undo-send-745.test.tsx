import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * UNDO SEND (Tynn #745; LiftPoint onboarding 00:31: "Once it's sent, it's sent. I don't have a way to back out").
 *
 * A Claude run takes a message mid-turn at once, so the host has nothing left to take back: the chat window holds a
 * message typed to a BUSY agent for UNDO_SEND_MS, with Undo (its words back in the composer) and Send now. An idle
 * agent's message, and one with files, go at once (the CONTROLs).
 *
 * No DOM (docs/decisions.md D3): the composer's props are captured and called, as in chat-acknowledged-send.test.tsx.
 */
const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@particle-academy/react-fancy', async (original) => {
    const real = await original<typeof import('@particle-academy/react-fancy')>();
    const PromptInput = (props: Record<string, unknown>) => { seen.push(props); return (real.PromptInput as unknown as { render: (p: unknown, ref: null) => unknown }).render(props, null); };
    return { ...real, PromptInput };
});
const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
const { ChatHeldSends } = await import('../src/renderer/components/ChatHeldSend.js');
const { SendGrace, UNDO_SEND_MS, draftWithUndone, holdsSend } = await import('../src/core/send-grace.js');
type ChatThread = import('../src/renderer/components/ChatFlyout.js').ChatThread;
type HeldSend = import('../src/core/send-grace.js').HeldSend;

afterEach(() => { vi.useRealTimers(); });

/** A grace window on fake time: what it sent, in order. */
function grace() {
    vi.useFakeTimers();
    const sent: string[] = [];
    const g = new SendGrace((h) => { sent.push(h.text); });
    return { g, sent };
}

describe('the grace window (core/send-grace.ts)', () => {
    it('a held message is NOT sent before the window ends, and is sent exactly once when it does', async () => {
        const { g, sent } = grace();
        g.hold('a_lark', 'fix the header');
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS - 1);
        expect(sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(sent).toEqual(['fix the header']);
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS * 3);
        expect(sent).toEqual(['fix the header']);
    });

    it('Undo inside the window answers the held words and the message is never sent', async () => {
        const { g, sent } = grace();
        const h = g.hold('a_lark', 'wrong agent, sorry');
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS / 2);
        expect(g.undo(h.id)?.text).toBe('wrong agent, sorry');
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS * 2);
        expect(sent).toEqual([]);
        expect(g.held('a_lark')).toEqual([]);
    });

    it('held() lists it for its chat while it waits; once it has gone it is not listed and Undo answers null', async () => {
        const { g } = grace();
        const h = g.hold('a_lark', 'one');
        expect(g.held('a_lark').map((x) => x.text)).toEqual(['one']);
        expect(g.held('a_wren')).toEqual([]);
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS);
        expect(g.held('a_lark')).toEqual([]);
        expect(g.undo(h.id)).toBeNull();
    });

    it('Send now sends at once, and the window ending later does not send it again', async () => {
        const { g, sent } = grace();
        const h = g.hold('a_lark', 'go');
        expect(g.sendNow(h.id)).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(['go']);
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS * 2);
        expect(sent).toEqual(['go']);
    });

    it('flush sends everything still held, in the order typed (the chat going away loses nothing)', async () => {
        const { g, sent } = grace();
        g.hold('a_lark', 'first');
        g.hold('a_wren', 'second');
        expect(sent).toEqual([]);
        g.flush();
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(['first', 'second']);
    });

    it('a busy agent and text only: held', () => {
        expect(holdsSend({ busy: true, files: 0 })).toBe(true);
    });

    it('CONTROL: an idle agent, or a message with files, is never held', () => {
        expect(holdsSend({ busy: false, files: 0 })).toBe(false);
        expect(holdsSend({ busy: true, files: 1 })).toBe(false);
    });

    it('Undo puts the words back AHEAD of anything typed since, keeping its pills', () => {
        const typed = { v: 1 as const, text: 'and also', pills: [{ id: 'p1', text: 'x', label: 'x' }] as never[], attachments: [] };
        const back = draftWithUndone(typed, 'fix the header');
        expect(back.text).toBe('fix the header\nand also');
        expect(back.pills).toEqual(typed.pills);
        expect(draftWithUndone(null, 'fix the header').text).toBe('fix the header');
    });
});

const A: ChatThread = { agentId: 'a_lark', name: 'lark', fidelity: 'declared', unread: null, messages: [] };
type Submit = (text: string, picked: unknown[]) => unknown;

function composer(busy: boolean, onSend: (...a: unknown[]) => Promise<{ kind: 'sent' }>) {
    seen.length = 0;
    renderToStaticMarkup(<ChatFlyout thread={A} busy={busy} onSend={onSend as never} onClose={() => {}} />);
    expect(seen).toHaveLength(1);
    return seen[0]!.onSubmit as Submit;
}

describe('the chat composer (ChatFlyout)', () => {
    it('to a BUSY agent: the composer empties at once, nothing is sent until the window ends, then it goes to that chat', async () => {
        vi.useFakeTimers();
        const onSend = vi.fn(async () => ({ kind: 'sent' as const }));
        const submit = composer(true, onSend);
        expect(await submit('fix the header', [])).toBeUndefined();
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS - 1);
        expect(onSend).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(onSend).toHaveBeenCalledTimes(1);
        expect(onSend.mock.calls[0]).toEqual(['fix the header', [], 'a_lark']);
    });

    it('CONTROL: to a busy agent WITH a file, it goes at once', async () => {
        const onSend = vi.fn(async () => ({ kind: 'sent' as const }));
        const submit = composer(true, onSend);
        await submit('see this', [{ id: 'f1', name: 'a.txt', bytes: 1, type: 'text/plain', file: new Blob(['a']) }]);
        await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    });

    it('CONTROL: to an idle agent, it goes at once', async () => {
        const onSend = vi.fn(async () => ({ kind: 'sent' as const }));
        const submit = composer(false, onSend);
        await submit('hello', []);
        expect(onSend).toHaveBeenCalledTimes(1);
    });
});

const held = (over: Partial<HeldSend> = {}): HeldSend => ({ id: 'h1', chat: 'a_lark', text: 'fix the header', until: 10_000, sending: false, ...over });

describe('the held message on screen (ChatHeldSend.tsx)', () => {
    it('drawn as your message, with Undo and Send now, by its handle', () => {
        const html = renderToStaticMarkup(<ChatHeldSends held={[held()]} now={5_000} onUndo={() => {}} onSendNow={() => {}} />);
        expect(html).toContain('data-chat-held="h1"');
        expect(html).toContain('fix the header');
        expect(html).toContain('data-action="undo-send"');
        expect(html).toContain('data-action="send-now"');
    });

    it('counts down the seconds left (rounded up), and says Sending with no Undo once it has gone to the host', () => {
        expect(renderToStaticMarkup(<ChatHeldSends held={[held()]} now={7_500} onUndo={() => {}} onSendNow={() => {}} />)).toContain('Sending in 3 s');
        const going = renderToStaticMarkup(<ChatHeldSends held={[held({ sending: true })]} now={7_500} onUndo={() => {}} onSendNow={() => {}} />);
        expect(going).toContain('Sending');
        expect(going).not.toContain('data-action="undo-send"');
    });
});

describe('wiring', () => {
    it('the Shell tells the chat its agent is mid-turn, and the chat draws what it holds', () => {
        const shell = readFileSync(new URL('../src/renderer/Shell.tsx', import.meta.url), 'utf8');
        expect(shell).toMatch(/<ChatFlyout[\s\S]*?\bbusy=\{chatSession\?\.running === true && chatSession\.turnState === 'working'\}/);
        const flyout = readFileSync(new URL('../src/renderer/components/ChatFlyout.tsx', import.meta.url), 'utf8');
        expect(flyout).toContain('<ChatHeldSendsLive');
    });
});
