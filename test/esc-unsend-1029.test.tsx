import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ESC UNSENDS (Tynn #1029; the owner, 2026-11-22: "when a user message is sent to chat, the esc key should unsend while
 * it's in the buffer time").
 *
 * The send buffer is the undo window of Tynn #745 (core/send-grace.ts): a message typed to a busy agent waits there, in
 * the window that sent it, and nothing reaches the host until the window ends. So unsend cancels delivery AT ITS SOURCE
 * (the timer that would have handed it to the host), and the host and every other client never saw it.
 *
 * - Esc inside the window: the newest held message of that chat comes back into its composer, attachments included,
 *   and is never sent.
 * - After the window (or with nothing held): Esc is not taken, and keeps its normal meaning (CONTROL).
 * - The held message says "Esc to unsend" beside its countdown.
 *
 * No DOM (docs/decisions.md D3): the composer's props are captured and called, as in undo-send-745.test.tsx; the key
 * handler is the pure `unsendOnEscape`. The real app's keypress is the CDP row (scripts/esc-unsend-cdp.mjs).
 */
const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@particle-academy/react-fancy', async (original) => {
    const real = await original<typeof import('@particle-academy/react-fancy')>();
    const PromptInput = (props: Record<string, unknown>) => { seen.push(props); return (real.PromptInput as unknown as { render: (p: unknown, ref: null) => unknown }).render(props, null); };
    return { ...real, PromptInput };
});
const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
const { ChatHeldSends } = await import('../src/renderer/components/ChatHeldSend.js');
const grace = await import('../src/core/send-grace.js');
const { SendGrace, UNDO_SEND_MS, draftWithUndone, holdsSend, putBackUndone, unsendOnEscape } = grace;
type ChatThread = import('../src/renderer/components/ChatFlyout.js').ChatThread;
type HeldSend = import('../src/core/send-grace.js').HeldSend;
type ChatDraft = import('../src/core/chat-drafts.js').ChatDraft;

afterEach(() => { vi.useRealTimers(); });

/** A key press as React hands it over, recording what the handler did with it. */
function press(key: string, over: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; defaultPrevented: boolean; isComposing: boolean }> = {}) {
    const did = { prevented: false, stopped: false };
    const e = {
        key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false, isComposing: false, ...over,
        preventDefault: () => { did.prevented = true; },
        stopPropagation: () => { did.stopped = true; },
    };
    return { e, did };
}

function fakeGrace() {
    vi.useFakeTimers();
    const sent: string[] = [];
    const g = new SendGrace((h) => { sent.push(h.text); });
    return { g, sent };
}

const draft = (text: string, attachments: ChatDraft['attachments'] = [], pills: ChatDraft['pills'] = []): ChatDraft => ({ v: 1, text, pills, attachments });

describe('Esc inside the window unsends (core/send-grace.ts unsendOnEscape)', () => {
    it('takes the newest held message of THIS chat, puts it back, and it is never sent; the key is consumed', async () => {
        const { g, sent } = fakeGrace();
        g.hold('a_lark', 'first');
        g.hold('a_wren', 'other chat');
        g.hold('a_lark', 'second');
        const back: HeldSend[] = [];
        const { e, did } = press('Escape');
        expect(unsendOnEscape(e, g, 'a_lark', (h) => back.push(h))).toBe(true);
        expect(did).toEqual({ prevented: true, stopped: true });
        expect(back.map((h) => h.text)).toEqual(['second']);
        // A second Esc takes the one before it.
        expect(unsendOnEscape(press('Escape').e, g, 'a_lark', (h) => back.push(h))).toBe(true);
        expect(back.map((h) => h.text)).toEqual(['second', 'first']);
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS * 2);
        // Delivery was cancelled at its source: only the other chat's message ever went.
        expect(sent).toEqual(['other chat']);
    });

    it('CONTROL: after the window ends, Esc is NOT taken (normal meaning), and the message went exactly once', async () => {
        const { g, sent } = fakeGrace();
        g.hold('a_lark', 'keep me');
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS);
        const back: HeldSend[] = [];
        const { e, did } = press('Escape');
        expect(unsendOnEscape(e, g, 'a_lark', (h) => back.push(h))).toBe(false);
        expect(did).toEqual({ prevented: false, stopped: false });
        expect(back).toEqual([]);
        expect(sent).toEqual(['keep me']);
    });

    it('CONTROL: once it has gone to the host (Sending), Esc cannot take it back', () => {
        vi.useFakeTimers();
        const g = new SendGrace(() => new Promise(() => {}));
        const h = g.hold('a_lark', 'going');
        g.sendNow(h.id);
        expect(g.held('a_lark')[0]?.sending).toBe(true);
        const { e, did } = press('Escape');
        expect(unsendOnEscape(e, g, 'a_lark', () => {})).toBe(false);
        expect(did.prevented).toBe(false);
    });

    it('CONTROL: nothing held in this chat (another chat holds one): not taken', () => {
        const { g } = fakeGrace();
        g.hold('a_wren', 'theirs');
        expect(unsendOnEscape(press('Escape').e, g, 'a_lark', () => {})).toBe(false);
        expect(g.held('a_wren')).toHaveLength(1);
    });

    it('only a bare Esc: modified, already handled (a menu closed), mid-IME, or another key is not taken', () => {
        const { g } = fakeGrace();
        g.hold('a_lark', 'held');
        for (const over of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { defaultPrevented: true }, { isComposing: true }]) {
            expect(unsendOnEscape(press('Escape', over).e, g, 'a_lark', () => {})).toBe(false);
        }
        expect(unsendOnEscape({ ...press('Escape').e, nativeEvent: { isComposing: true } }, g, 'a_lark', () => {})).toBe(false);
        expect(unsendOnEscape(press('Enter').e, g, 'a_lark', () => {})).toBe(false);
        expect(g.held('a_lark')).toHaveLength(1);
    });

    it('unsendLatest answers null when nothing of that chat is waiting', () => {
        const { g } = fakeGrace();
        expect(g.unsendLatest('a_lark')).toBeNull();
    });
});

describe('attachments ride the window and come back (core/send-grace.ts)', () => {
    const file = { id: 'f1', name: 'shot.png', bytes: 3, type: 'image/png', file: new File(['png'], 'shot.png', { type: 'image/png' }) };

    it('a busy agent: held with files too (the person can still take it back)', () => {
        expect(holdsSend({ busy: true, files: 2 })).toBe(true);
        expect(holdsSend({ busy: false, files: 2 })).toBe(false);
    });

    it('a held message keeps the composer draft and its files; undo answers them; the send is handed them', async () => {
        vi.useFakeTimers();
        const handed: HeldSend[] = [];
        const g = new SendGrace((h) => { handed.push(h); });
        const d = draft('see this', [{ id: 'f1', name: 'shot.png', type: 'image/png', bytes: 3 }]);
        const a = g.hold('a_lark', 'see this', { draft: d, attachments: [file] });
        expect(a.draft).toEqual(d);
        expect(a.attachments).toEqual([file]);
        const b = g.hold('a_lark', 'and this', { draft: draft('and this'), attachments: [file] });
        expect(g.undo(a.id)?.attachments).toEqual([file]);
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS);
        expect(handed.map((h) => h.id)).toEqual([b.id]);
        expect(handed[0]!.attachments).toEqual([file]);
    });

    it('the undone DRAFT goes back ahead of what was typed since: its text, pills and attachments', () => {
        const typed = draft('and also', [{ id: 'f9', name: 'later.txt', type: 'text/plain', bytes: 1 }], [{ kind: 'text', id: 'p9', text: 'later paste' }]);
        const undone = draft('fix ⁣paste⁣', [{ id: 'f1', name: 'shot.png', type: 'image/png', bytes: 3 }], [{ kind: 'text', id: 'p1', text: 'big paste' }]);
        const back = draftWithUndone(typed, undone);
        expect(back.text).toBe('fix ⁣paste⁣\nand also');
        expect(back.pills.map((p) => p.id)).toEqual(['p1', 'p9']);
        expect(back.attachments.map((a) => a.id)).toEqual(['f1', 'f9']);
        expect(draftWithUndone(null, undone)).toEqual(undone);
        // Text alone still works as before (#745).
        expect(draftWithUndone(typed, 'words').text).toBe('words\nand also');
    });

    it('putBackUndone with a draft sets the whole draft (files included) and keeps it', () => {
        const set: ChatDraft[] = [];
        const kept: ChatDraft[] = [];
        const handles = new Map([['a_lark', { getDraft: () => draft(''), setDraft: (d: ChatDraft) => { set.push(d); } }]]);
        const undone = draft('see this', [{ id: 'f1', name: 'shot.png', type: 'image/png', bytes: 3 }]);
        putBackUndone(handles, 'a_lark', undone, true, { initial: () => null, change: (_c, d) => { kept.push(d); } });
        expect(set[0]).toEqual(undone);
        expect(kept[0]).toEqual(undone);
    });
});

describe('the held message says Esc (ChatHeldSend.tsx)', () => {
    const held = (over: Partial<HeldSend> = {}): HeldSend => ({ id: 'h1', chat: 'a_lark', text: 'fix the header', until: 10_000, sending: false, ...over });

    it('beside the countdown: "Esc to unsend", and Undo names the key', () => {
        const html = renderToStaticMarkup(<ChatHeldSends held={[held()]} now={7_500} onUndo={() => {}} onSendNow={() => {}} />);
        expect(html).toContain('Sending in 3 s');
        expect(html).toMatch(/data-unsend-hint=""[^>]*>[\s\S]*Esc[\s\S]*to unsend/);
        expect(html).toMatch(/data-action="undo-send"[^>]*aria-keyshortcuts="Escape"|aria-keyshortcuts="Escape"[^>]*data-action="undo-send"/);
    });

    it('CONTROL: once it is Sending there is no Esc hint (nothing left to unsend)', () => {
        const html = renderToStaticMarkup(<ChatHeldSends held={[held({ sending: true })]} now={7_500} onUndo={() => {}} onSendNow={() => {}} />);
        expect(html).not.toContain('data-unsend-hint');
    });

    it('its files are named on it, so the person sees what is waiting', () => {
        const html = renderToStaticMarkup(<ChatHeldSends held={[held({ attachments: [{ id: 'f1', name: 'shot.png' }] })]} now={7_500} onUndo={() => {}} onSendNow={() => {}} />);
        expect(html).toContain('data-chat-held-file="f1"');
        expect(html).toContain('shot.png');
    });
});

const A: ChatThread = { agentId: 'a_lark', name: 'lark', fidelity: 'declared', unread: null, messages: [] };
type Submit = (text: string, picked: unknown[]) => unknown;

function composer(busy: boolean, onSend: (...a: unknown[]) => Promise<{ kind: 'sent' }>) {
    seen.length = 0;
    renderToStaticMarkup(<ChatFlyout thread={A} busy={busy} onSend={onSend as never} onClose={() => {}} />);
    expect(seen).toHaveLength(1);
    return seen[0]!;
}

describe('the chat composer holds files too (ChatFlyout)', () => {
    it('to a BUSY agent WITH a file: nothing is sent inside the window; then it goes with the file bytes, to that chat', async () => {
        vi.useFakeTimers();
        const onSend = vi.fn(async () => ({ kind: 'sent' as const }));
        const props = composer(true, onSend);
        const picked = [{ id: 'f1', name: 'a.txt', bytes: 1, type: 'text/plain', file: new File(['a'], 'a.txt', { type: 'text/plain' }) }];
        expect(await (props.onSubmit as Submit)('see this', picked)).toBeUndefined();
        await vi.advanceTimersByTimeAsync(UNDO_SEND_MS - 1);
        expect(onSend).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        const [text, files, chat] = onSend.mock.calls[0] as unknown as [string, Array<{ name: string; bytes: Uint8Array }>, string];
        expect([text, chat]).toEqual(['see this', 'a_lark']);
        expect(files.map((f) => [f.name, new TextDecoder().decode(f.bytes)])).toEqual([['a.txt', 'a']]);
    });

    it('a held file comes back to the composer: restoreAttachment answers its File, even with no draft store', async () => {
        vi.useFakeTimers();
        const onSend = vi.fn(async () => ({ kind: 'sent' as const }));
        const props = composer(true, onSend);
        const f = new File(['a'], 'a.txt', { type: 'text/plain' });
        await (props.onSubmit as Submit)('see this', [{ id: 'f1', name: 'a.txt', bytes: 1, type: 'text/plain', file: f }]);
        const restore = props.restoreAttachment as ((entry: { id: string; name: string; type: string; bytes: number }) => unknown) | undefined;
        expect(typeof restore).toBe('function');
        expect(await restore!({ id: 'f1', name: 'a.txt', type: 'text/plain', bytes: 1 })).toBe(f);
    });

    it('CONTROL: to an idle agent with a file, it goes at once', async () => {
        const onSend = vi.fn(async () => ({ kind: 'sent' as const }));
        const props = composer(false, onSend);
        await (props.onSubmit as Submit)('see this', [{ id: 'f1', name: 'a.txt', bytes: 1, type: 'text/plain', file: new File(['a'], 'a.txt') }]);
        await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    });
});

describe('wiring', () => {
    it('the chat takes Esc for its held messages, on the chat itself (so the Agent view’s Esc keeps its meaning otherwise)', () => {
        const flyout = readFileSync(new URL('../src/renderer/components/ChatFlyout.tsx', import.meta.url), 'utf8');
        expect(flyout).toMatch(/<aside[\s\S]{0,1600}?onKeyDown=\{[^}]*unsendOnEscape\(/);
    });
});
