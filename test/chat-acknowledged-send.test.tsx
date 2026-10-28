import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../src/core/prompt-content.js';

/**
 * A SEND THAT FAILS NEVER LOSES THE MESSAGE (react-fancy 5.70.0, acknowledged send).
 *
 * The chat composer's `onSubmit` used to start reading the attachments and return nothing, so react-fancy emptied the
 * composer at once — before the host had answered. A send the host refused for a reason (a file the provider cannot
 * take), one that threw, a Take Over window's mail that failed, or a window not connected to Genie: the person's
 * message was gone, and for most of those nothing on screen said so.
 *
 * Now `onSubmit` returns the send. react-fancy keeps the draft until it resolves, refuses a second send while it is in
 * flight, keeps text typed meanwhile, and keeps the draft when it resolves `{ ok: false }`. Each message lives in ONE
 * place: a refusal comes back to the composer (no undelivered bubble beside it); an agent that is not running keeps
 * it as not delivered in the thread, with its Restart (genie#1238), and the composer empties.
 *
 * No DOM (docs/decisions.md D3): the props Genie hands react-fancy are captured and called. The core module is
 * imported lazily so that on origin/main these tests fail on their assertions, not on a missing file.
 */
const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@particle-academy/react-fancy', async (original) => {
    const real = await original<typeof import('@particle-academy/react-fancy')>();
    const PromptInput = (props: Record<string, unknown>) => { seen.push(props); return (real.PromptInput as unknown as { render: (p: unknown, ref: null) => unknown }).render(props, null); };
    return { ...real, PromptInput };
});
const flyout = await import('../src/renderer/components/ChatFlyout.js');
const { ChatFlyout } = flyout;
type ChatThread = import('../src/renderer/components/ChatFlyout.js').ChatThread;
const chatSend = () => import('../src/core/chat-send.js');

const A: ChatThread = { agentId: 'a_lark', name: 'lark', fidelity: 'declared', unread: null, messages: [] };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const REF = '00000000-0000-4000-8000-000000000001';
const LARK = { v: 1 as const, text: 'half-typed to lark', pills: [], attachments: [{ id: 'f1', name: 'shot.png', type: 'image/png', bytes: 4, ref: REF }] };
const PICKED = [{ id: 'f1', name: 'shot.png', bytes: 4, type: 'image/png', ref: REF }];

async function keeper(stored: Record<string, unknown>) {
    const { ChatDraftKeeper } = await import('../src/core/chat-draft-keeper.js');
    const calls: Array<[string, ...unknown[]]> = [];
    const files = new Map<string, Uint8Array>([[REF, PNG]]);
    const k = new ChatDraftKeeper({
        load: async () => stored,
        save: async (agentId: string, d: unknown) => { calls.push(['save', agentId, d]); },
        putFile: async () => REF,
        readFile: async (ref: string) => files.get(ref) ?? null,
        release: async (refs: readonly string[]) => { calls.push(['release', [...refs]]); },
    }, { setTimer: () => 0, clearTimer: () => {} });
    await k.load();
    return { k, calls };
}

type Outcome = { kind: 'sent' } | { kind: 'kept' } | { kind: 'failed'; reason: string };
type OnSend = (text: string, files?: readonly Attachment[], agentId?: string) => void | Promise<Outcome>;
type Submit = (text: string, picked: unknown[]) => unknown;

/** The composer of lark's chat, with `onSend` as given; what Genie handed react-fancy. */
async function composer(onSend: OnSend) {
    const { k, calls } = await keeper({ a_lark: LARK });
    seen.length = 0;
    renderToStaticMarkup(<ChatFlyout thread={A} drafts={k} onSend={onSend as never} onClose={() => {}} />);
    expect(seen).toHaveLength(1);
    return { props: seen[0]!, submit: seen[0]!.onSubmit as Submit, k, calls };
}

/** A send the test answers when it chooses. */
function deferred() {
    let answer!: (o: Outcome) => void;
    const promise = new Promise<Outcome>((r) => { answer = r; });
    return { promise, answer };
}

const isThenable = (v: unknown): v is PromiseLike<unknown> => v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function';

/** Whether a promise has settled after the microtasks queued so far (and a macrotask) have run. */
async function settled(p: PromiseLike<unknown>): Promise<boolean> {
    let done = false;
    void Promise.resolve(p).then(() => { done = true; }, () => { done = true; });
    await new Promise((r) => setTimeout(r, 20));
    return done;
}

describe('a failed send keeps the draft', () => {
    it('the host refuses (a file the provider cannot take): onSubmit resolves { ok: false, error } with the reason, and the stored file is NOT released', async () => {
        const { submit, k, calls } = await composer(async () => ({ kind: 'failed', reason: 'Codex cannot take shot.png' }));
        const result = submit('half-typed to lark', PICKED);
        expect(isThenable(result), 'onSubmit must return the send for react-fancy to wait on').toBe(true);
        expect(await result).toEqual({ ok: false, error: 'Codex cannot take shot.png' });
        // The kept draft, files and all, is still what a restart comes back to.
        expect(calls.filter((c) => c[0] === 'release')).toEqual([]);
        expect(k.initial('a_lark')).toEqual(LARK);
    });

    it('the send THROWS (an IPC error): resolves { ok: false } with the error’s words, never rejects silently', async () => {
        const { submit, calls } = await composer(() => Promise.reject(new Error("Error invoking remote method 'genie:prompt': Error: host gone")));
        const result = submit('half-typed to lark', PICKED);
        expect(isThenable(result)).toBe(true);
        expect(await result).toEqual({ ok: false, error: 'host gone' });
        expect(calls.filter((c) => c[0] === 'release')).toEqual([]);
    });

    it('the person sees why: the composer is given onSubmitError, and the line it shows names the reason', async () => {
        const { props } = await composer(async () => ({ kind: 'sent' }));
        expect(typeof props.onSubmitError).toBe('function');
        const html = renderToStaticMarkup(<flyout.ComposerSendError chat="a_lark" error="Codex cannot take shot.png" />);
        expect(html).toContain('data-chat-send-error="a_lark"');
        expect(html).toContain('Not sent: Codex cannot take shot.png');
        // react-fancy's own alert (visually hidden) is the one announced; Genie's line is the one SEEN — not a second alert.
        expect(html).not.toContain('role="alert"');
        expect(renderToStaticMarkup(<flyout.ComposerSendError chat="a_lark" error={null} />)).toBe('');
    });
});

describe('a successful send clears it', () => {
    it('resolves to nothing (react-fancy empties the composer), its stored files are released, and the reset clears the kept draft at once', async () => {
        const sent: Array<[string, readonly Attachment[] | undefined, string | undefined]> = [];
        const { props, submit, calls } = await composer(async (text, files, agentId) => { sent.push([text, files, agentId]); return { kind: 'sent' }; });
        const result = submit('half-typed to lark', PICKED);
        expect(isThenable(result)).toBe(true);
        expect(await result).toBeUndefined();
        expect(sent).toHaveLength(1);
        expect(sent[0]![1]![0]!.bytes).toEqual(PNG);
        expect(calls).toContainEqual(['release', [REF]]);
        // react-fancy's reset once the send is acknowledged (5.70 docs: onDraftChange with the empty draft).
        (props.onDraftChange as (d: unknown) => void)({ v: 1, text: '', pills: [], attachments: [] });
        expect(calls).toContainEqual(['save', 'a_lark', null]);
    });

    it('an agent that is NOT RUNNING: the thread keeps the message as not delivered (genie#1238), so the composer empties too', async () => {
        const { submit } = await composer(async () => ({ kind: 'kept' }));
        expect(await (submit('to lark', []) as Promise<unknown>)).toBeUndefined();
    });
});

describe('text typed during a send is kept', () => {
    it('the send stays pending until the host answers, and the newer draft typed meanwhile is the one kept', async () => {
        const host = deferred();
        const { props, submit, k } = await composer(() => host.promise);
        const result = submit('half-typed to lark', PICKED);
        expect(isThenable(result), 'a void onSubmit is cleared at once, taking what is typed meanwhile with it').toBe(true);
        expect(await settled(result as PromiseLike<unknown>)).toBe(false);
        // The person keeps typing while it is in flight (the text stays editable in 5.70).
        const newer = { ...LARK, text: 'half-typed to lark, and one more thing' };
        (props.onDraftChange as (d: unknown) => void)(newer);
        host.answer({ kind: 'sent' });
        expect(await result).toBeUndefined();
        // react-fancy clears only the draft that was sent; it changed, so nothing resets it. Genie's store holds the newer.
        expect(k.initial('a_lark')).toEqual(newer);
    });
});

describe('no double submit', () => {
    it('one send, one delivery: onSend runs once, and the in-flight promise is what react-fancy refuses a second send against', async () => {
        const host = deferred();
        const onSend = vi.fn<OnSend>(() => host.promise);
        const { submit } = await composer(onSend);
        const result = submit('to lark', []);
        expect(isThenable(result)).toBe(true);
        await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        expect(await settled(result as PromiseLike<unknown>)).toBe(false);
        host.answer({ kind: 'sent' });
        await result;
        expect(onSend).toHaveBeenCalledTimes(1);
    });

    it('a refusal with a reason goes back to the composer ONLY: no undelivered bubble beside the kept draft', async () => {
        const { deliverChat } = await chatSend();
        const keepUndelivered = vi.fn();
        const out = await deliverChat({ kind: 'prompt' }, 'to lark', [], {
            prompt: async () => ({ ok: false, reason: 'Codex cannot take shot.png' }),
            mail: async () => undefined,
            keepUndelivered,
        });
        expect(out).toEqual({ kind: 'failed', reason: 'Codex cannot take shot.png' });
        expect(keepUndelivered).not.toHaveBeenCalled();
    });

    it('an agent not running: the thread keeps it ONCE (its Restart sends it) and the composer is told to empty, so it is not sent twice', async () => {
        const { deliverChat, composerAck } = await chatSend();
        const keepUndelivered = vi.fn();
        const out = await deliverChat({ kind: 'prompt' }, 'to lark', [], { prompt: async () => ({ ok: false }), mail: async () => undefined, keepUndelivered });
        expect(out).toEqual({ kind: 'kept' });
        expect(keepUndelivered).toHaveBeenCalledTimes(1);
        expect(composerAck(out)).toBeUndefined();
    });

    it('delivered or queued for the turn (genie#1143/#1144): sent, nothing kept in the thread', async () => {
        const { deliverChat } = await chatSend();
        const keepUndelivered = vi.fn();
        expect(await deliverChat({ kind: 'prompt' }, 'to lark', [], { prompt: async () => ({ ok: true }), mail: async () => undefined, keepUndelivered })).toEqual({ kind: 'sent' });
        expect(keepUndelivered).not.toHaveBeenCalled();
    });

    it('not connected to Genie, a Take Over window’s mail failing, or files for one: failed with the reason — never only the console', async () => {
        const { deliverChat } = await chatSend();
        const ports = { prompt: null, mail: async () => undefined, keepUndelivered: vi.fn() };
        expect(await deliverChat({ kind: 'prompt' }, 'x', [], ports)).toEqual({ kind: 'failed', reason: 'Genie is not connected.' });
        const mailFails = { ...ports, mail: () => Promise.reject(new Error("Error invoking remote method 'genie:feature-act': Error: inbox closed")) };
        expect(await deliverChat({ kind: 'inbox', to: 'w:claude:wren' }, 'x', [], mailFails)).toEqual({ kind: 'failed', reason: 'inbox closed' });
        const files: Attachment[] = [{ name: 'a.png', type: 'image/png', bytes: PNG }];
        expect(await deliverChat({ kind: 'inbox', to: 'w:claude:wren' }, 'x', files, ports)).toEqual({ kind: 'failed', reason: 'Files cannot be sent to a Take Over window from here yet.' });
        expect(ports.keepUndelivered).not.toHaveBeenCalled();
    });

    it('the react-fancy Genie runs has the acknowledged send (5.70.0 or later)', () => {
        const pkg = JSON.parse(readFileSync(new URL('../node_modules/@particle-academy/react-fancy/package.json', import.meta.url), 'utf8')) as { version: string };
        const [major, minor] = pkg.version.split('.').map(Number) as [number, number];
        expect(major > 5 || (major === 5 && minor >= 70), pkg.version).toBe(true);
    });
});

describe('wiring', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    it('the window’s composer send goes through deliverChat and RETURNS its outcome; a saved prompt (no composer) keeps a failure as not delivered', () => {
        const app = strip('../src/renderer/App.tsx');
        expect(app).toMatch(/deliverChat\(/);
        expect(app).toMatch(/onSend=\{\(id, text, attachments\) => \(id \? send\(id, text, attachments \?\? \[\]\)/);
        const shell = strip('../src/renderer/Shell.tsx');
        expect(shell).toMatch(/onSend=\{\(text, attachments, agentId\) => \(scope\.kind !== 'blocked' \? onSend\(/);
    });
});
