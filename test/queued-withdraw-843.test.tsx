import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { chatMessages } from '../src/core/chat-view.js';
import type { ChatDraft } from '../src/core/chat-drafts.js';
import { memoryPair } from '../src/core/line-transport.js';
import { composerEmpty, takeBackQueued, withdrawAction } from '../src/core/queued-withdraw.js';
import { SendGrace } from '../src/core/send-grace.js';
import type { DriverEvents, SessionDriverFactory, TurnOutcomeLike } from '../src/core/session.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { ChatFlyout, ChatMessages, type ChatThread, type ChatThreadMessage } from '../src/renderer/components/ChatFlyout.js';
import { control } from './helpers/control-markup.js';

/**
 * WITHDRAW / EDIT A QUEUED MESSAGE (Tynn #843; the owner, beta.65: "if an item is queued can I still undo the send even
 * if past the buffer"). Undo send (#745) covers the 5 s before a send. A message Genie then HOLDS for the turn's end
 * (Codex refuses a second prompt mid-turn; a provider pause; an agent starting) has not reached the agent, so the person
 * can still take it back: Withdraw (kept in the thread, marked Withdrawn; or, with the composer empty, its words back in
 * the composer) and Edit (its words back in the composer). A real host operation, atomic against the turn's end handing
 * it to the provider: whichever comes first wins, and a lost withdraw is told plainly.
 *
 * Predicted on the inert stubs: 19 failed, 5 passed (24). The 5 are the named CONTROLs, which hold either way. One test
 * was added with GREEN (Edit on a withdrawn message); the GREEN job proves it with a break probe.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function open(provider: 'codex' | 'claude' = 'codex') {
    const dir = await mkdtemp(join(tmpdir(), 'genie-withdraw-843-'));
    let events: DriverEvents = {};
    let busy = false;
    const prompts: unknown[] = [];
    const hook: { onPrompt: ((content: unknown) => void) | null } = { onPrompt: null };
    const options: ConstructorParameters<typeof SessionHost>[0] = {
        userData: dir,
        processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) },
        driverFor: () => (o) => {
            events = o.events;
            return {
                start() {}, kill() { busy = false; }, cancel() {},
                cliSessionId: null,
                prompt(content) {
                    if (provider === 'codex' && busy) throw new Error('Codex turn already in flight');
                    busy = true;
                    prompts.push(content);
                    hook.onPrompt?.(content);
                },
            };
        },
    };
    const host = new SessionHost(options);
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'w', name: 'worker', provider });
    expect(host.start(record, dir)).toEqual({ ok: true });
    cleanups.push(async () => { host.stopAll(); await host.settled(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
    const messages = (h: SessionHost = host) => chatMessages({ agent: { ...record, fidelity: 'declared' }, session: h.probe(record.id), rows: h.ledgerFor(record.id) });
    const end = (stopReason: TurnOutcomeLike['stopReason'] = 'end_turn') => {
        busy = false;
        events.onTurnEnd?.({ stopReason, isError: false, raw: null });
    };
    const pid = (text: string): string => {
        const id = messages().find((m) => m.text === text)?.promptId;
        if (!id) throw new Error(`no queued prompt for ${text}`);
        return id;
    };
    const deliveries = (id: string) => host.ledgerFor(record.id).flatMap(({ event: e }) => (e.kind === 'prompt_delivery' && e.id === id ? [e.status] : []));
    return { host, record, prompts, messages, end, pid, deliveries, hook, dir, options };
}

const thread = (messages: readonly ChatThreadMessage[]): ChatThread => ({ agentId: 'a_worker', name: 'worker', fidelity: 'declared', unread: null, messages, context: null });
const draft = (text: string, extra: Partial<ChatDraft> = {}): ChatDraft => ({ v: 1, text, pills: [], attachments: [], ...extra });

describe('the host takes a queued message back (resolvePrompt withdraw / edit)', () => {
    it('Withdraw: the agent never gets it, the one behind it goes in its place, and the thread marks it Withdrawn', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'oops', []);
        s.host.promptWith(s.record.id, 'next', []);
        const oops = s.pid('oops');
        expect(await s.host.resolvePrompt(s.record.id, oops, 'withdraw')).toEqual({ ok: true });
        s.end();
        s.end();
        expect(s.prompts).toEqual(['first', 'next']);
        expect(s.deliveries(oops)).toEqual(['withdrawn']);
        expect(s.messages().find((m) => m.text === 'oops')).toMatchObject({ delivered: false, queued: false, withdrawn: true });
    });

    it('Edit: out of the queue AND out of the thread (its words went back to the composer)', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'oops', []);
        const oops = s.pid('oops');
        expect(await s.host.resolvePrompt(s.record.id, oops, 'edit')).toEqual({ ok: true });
        s.end();
        expect(s.prompts).toEqual(['first']);
        expect(s.deliveries(oops)).toEqual(['discarded']);
        expect(s.messages().some((m) => m.text === 'oops')).toBe(false);
    });

    // Added after RED (with GREEN); its break probe runs in the GREEN job: the record check in resolvePrompt removed, it goes red.
    it('Edit on a message already withdrawn (kept, marked) takes it out of the thread; the agent still never gets it', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'oops', []);
        const oops = s.pid('oops');
        expect(await s.host.resolvePrompt(s.record.id, oops, 'withdraw')).toEqual({ ok: true });
        expect(await s.host.resolvePrompt(s.record.id, oops, 'edit')).toEqual({ ok: true });
        expect(s.deliveries(oops)).toEqual(['withdrawn', 'discarded']);
        expect(s.messages().some((m) => m.text === 'oops')).toBe(false);
        s.end();
        expect(s.prompts).toEqual(['first']);
    });

    it('delivered first: a late Withdraw is refused in plain words, and the message stays delivered', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'oops', []);
        const oops = s.pid('oops');
        s.end();
        expect(s.prompts).toEqual(['first', 'oops']);
        const late = await s.host.resolvePrompt(s.record.id, oops, 'withdraw');
        expect(late.ok).toBe(false);
        expect(late.ok ? '' : late.reason).toMatch(/too late.*already has it/i);
        expect(s.deliveries(oops)).toEqual(['sent']);
        expect(s.messages().find((m) => m.text === 'oops')).toMatchObject({ delivered: true });
    });

    it('THE RACE: a Withdraw arriving while the turn\'s end hands the message to the provider loses cleanly — delivered once, the queue behind it intact', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'oops', []);
        s.host.promptWith(s.record.id, 'next', []);
        const oops = s.pid('oops');
        let raced: ReturnType<SessionHost['withdrawQueued']> | null = null;
        // The same moment: the withdraw runs INSIDE the provider's hand-off of that very message.
        s.hook.onPrompt = (content) => { if (content === 'oops') raced = s.host.withdrawQueued(s.record.id, oops, 'withdraw'); };
        s.end();
        expect(raced).not.toBeNull();
        expect(raced!.ok).toBe(false);
        expect(raced!.ok ? '' : raced!.reason).toMatch(/too late.*already has it/i);
        expect(s.deliveries(oops)).toEqual(['sent']);
        s.hook.onPrompt = null;
        s.end();
        expect(s.prompts).toEqual(['first', 'oops', 'next']);
    });

    it('THE RACE, the other way: Withdraw first, the turn ends in the same tick — the agent never gets it', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'oops', []);
        s.host.promptWith(s.record.id, 'next', []);
        const won = s.host.withdrawQueued(s.record.id, s.pid('oops'), 'withdraw');
        s.end();
        expect(won).toEqual({ ok: true });
        expect(s.prompts).toEqual(['first', 'next']);
    });

    it('the waiting count drops by one and Send all now (stop the current turn) is still offered', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'oops', []);
        s.host.promptWith(s.record.id, 'next', []);
        const draw = () => renderToStaticMarkup(<ChatFlyout thread={{ ...thread(s.messages()), agentId: s.record.id }} onSend={() => {}} onClose={() => {}} onInterruptAndSend={() => {}} />);
        expect(draw()).toContain('2 waiting');
        await s.host.resolvePrompt(s.record.id, s.pid('oops'), 'withdraw');
        const after = draw();
        expect(after).toContain('1 waiting');
        expect(control(after, 'data-action="send-all-now"')).not.toBeNull();
        expect(after).not.toContain('data-chat-queue="undelivered"');
    });

    it('only the person\'s own message: another sender\'s queued prompt is not withdrawn', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        expect(s.host.prompt(s.record.id, 'a flow step', 'nightly')).toBe(true);
        const step = s.host.ledgerFor(s.record.id).flatMap(({ event: e }) => (e.kind === 'message' && e.text === 'a flow step' && e.pending ? [e.pending.id] : []))[0]!;
        const refused = s.host.withdrawQueued(s.record.id, step, 'withdraw');
        expect(refused.ok ? '' : refused.reason).toMatch(/only your own/i);
        s.end();
        expect(s.prompts).toEqual(['first', 'a flow step']);
    });

    it('a Restart never owes a withdrawn message', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'oops', []);
        await s.host.resolvePrompt(s.record.id, s.pid('oops'), 'withdraw');
        s.host.stop(s.record.id);
        await s.host.settled();
        const reopened = new SessionHost(s.options);
        cleanups.unshift(async () => { reopened.stopAll(); await reopened.settled(); });
        expect(reopened.start(s.record, s.dir)).toEqual({ ok: true });
        expect(await reopened.deliverOwed(s.record.id)).toBe(0);
        expect(s.prompts).toEqual(['first']);
    });

    it('CONTROL: without a withdraw, both queued messages reach the agent, in order (the harness delivers)', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'oops', []);
        s.host.promptWith(s.record.id, 'next', []);
        s.end();
        s.end();
        expect(s.prompts).toEqual(['first', 'oops', 'next']);
    });

    it('CONTROL: a Claude message mid-turn goes to the provider at once — nothing queued, nothing to withdraw', async () => {
        const s = await open('claude');
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'more', []);
        expect(s.prompts).toEqual(['first', 'more']);
        expect(s.messages().some((m) => m.queued)).toBe(false);
    });
});

describe('the Pilot (host-api) and engine paths', () => {
    it('Pilot: resolvePrompt withdraw is a host action — the agent never gets it', async () => {
        const s = await open();
        const api = buildHostApi({ host: s.host, find: (id: string) => (id === s.record.id ? s.record : null) } as unknown as HostApiDeps);
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'from my phone, wrong', []);
        expect(await api.invoke('resolvePrompt', [s.record.id, s.pid('from my phone, wrong'), 'withdraw'])).toEqual({ ok: true });
        s.end();
        expect(s.prompts).toEqual(['first']);
    });

    it('CONTROL: Pilot still refuses an action that is not one', async () => {
        const s = await open();
        const api = buildHostApi({ host: s.host, find: (id: string) => (id === s.record.id ? s.record : null) } as unknown as HostApiDeps);
        expect(await api.invoke('resolvePrompt', [s.record.id, 'p', 'explode'])).toEqual({ ok: false, reason: 'Invalid draft action.' });
    });

    it('engine: the window\'s client hands withdraw through to the host as a withdraw (never turned into a discard)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie-withdraw-843-engine-'));
        const token = 'c'.repeat(64);
        const server = new SessionEngineServer({ token, build: 'test', schedule: (_ms, fn) => { queueMicrotask(fn); return () => {}; } });
        let events: DriverEvents | null = null;
        let busy = false;
        const prompts: unknown[] = [];
        const factory: SessionDriverFactory = (o) => {
            events = o.events;
            return { start() {}, kill() {}, get cliSessionId() { return null; }, prompt(c: unknown) { if (busy) throw new Error('Codex turn already in flight'); busy = true; prompts.push(c); } };
        };
        const host = new SessionHost({ userData: dir, driverFor: () => factory, processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        cleanups.push(async () => { await host.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        expect(await client.connect(windowSide, token)).toMatchObject({ ok: true });
        const r = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'atlas' });
        expect(await client.start(r, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(events).not.toBeNull());
        host.promptWith(r.id, 'first', []);
        host.promptWith(r.id, 'oops', []);
        const oops = host.ledgerFor(r.id).flatMap(({ event: e }) => (e.kind === 'message' && e.text === 'oops' && e.pending ? [e.pending.id] : []))[0]!;
        expect(await client.resolvePrompt(r.id, oops, 'withdraw')).toEqual({ ok: true });
        expect(host.ledgerFor(r.id).flatMap(({ event: e }) => (e.kind === 'prompt_delivery' && e.id === oops ? [e.status] : []))).toEqual(['withdrawn']);
        busy = false;
        events!.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        expect(prompts).toEqual(['first']);
    });
});

describe('the chat draws it', () => {
    const queued: ChatThreadMessage = { id: 'm2', who: 'you', from: 'you', text: 'oops', delivered: false, queued: true, promptId: 'p2', silentSince: null, at: null };
    const draw = (messages: readonly ChatThreadMessage[], extra: Partial<Parameters<typeof ChatMessages>[0]> = {}) =>
        renderToStaticMarkup(<ChatMessages messages={messages} thread={thread(messages)} refs={{ files: false, agents: [], workspaces: [] }} mailOnly={false} onQueuedAction={() => {}} {...extra} />);

    it('a queued message of yours shows Withdraw and Edit, react-fancy buttons on its Queued line — behind a turn, a provider pause and a start alike', () => {
        for (const m of [queued, { ...queued, queuedForProvider: true }, { ...queued, queuedForStart: true }]) {
            const html = draw([m]);
            const withdraw = control(html, 'data-action="withdraw-queued"');
            const edit = control(html, 'data-action="edit-queued"');
            expect(withdraw).toMatchObject({ fancy: true, text: 'Withdraw' });
            expect(edit).toMatchObject({ fancy: true, text: 'Edit' });
        }
    });

    it('CONTROL: a delivered message, an agent reply and an undelivered draft offer no Withdraw', () => {
        const html = draw([
            { id: 'm1', who: 'you', from: 'you', text: 'sent', delivered: true, at: null },
            { id: 'm3', who: 'agent', from: 'worker', text: 'reply', delivered: true, at: null },
            { id: 'm4', who: 'you', from: 'you', text: 'kept', delivered: false, queued: false, promptId: 'p4', at: null },
        ]);
        expect(html).not.toContain('withdraw-queued');
        expect(html).not.toContain('edit-queued');
    });

    it('a withdrawn message reads Withdrawn, with Edit and remove, and is not counted as not delivered', () => {
        const withdrawn: ChatThreadMessage = { ...queued, queued: false, withdrawn: true };
        const html = renderToStaticMarkup(<ChatFlyout thread={thread([withdrawn])} onSend={() => {}} onClose={() => {}} onDiscardDraft={() => {}} onResolveQueued={async () => ({ ok: true })} onInterruptAndSend={() => {}} />);
        expect(html).toContain('data-chat-withdrawn="m2"');
        expect(html).toContain('Withdrawn');
        expect(control(html, 'data-action="edit-queued"')).toMatchObject({ fancy: true, text: 'Edit' });
        expect(control(html, 'data-action="remove-draft"')).not.toBeNull();
        expect(html).not.toContain('Not delivered');
        expect(html).not.toContain('data-chat-queue="undelivered"');
        expect(html).not.toContain('data-chat-queue="waiting"');
    });

    it('a lost race is said on the message, plainly', () => {
        const html = draw([{ ...queued, queued: false, delivered: true }], { queuedProblems: { m2: 'Too late: the agent already has it.' } });
        expect(html).toMatch(/role="alert"[^>]*>Too late: the agent already has it\.</);
    });

    it('while the host answers, the buttons are disabled (one press, one action)', () => {
        const html = draw([queued], { queuedBusy: new Set(['m2']) });
        expect(control(html, 'data-action="withdraw-queued"')?.open).toMatch(/\sdisabled(=""|\s|>)/);
        expect(control(html, 'data-action="edit-queued"')?.open).toMatch(/\sdisabled(=""|\s|>)/);
    });
});

describe('what a press does (core/queued-withdraw.ts)', () => {
    const run = (pressed: 'withdraw' | 'edit', composer: ChatDraft | null, answer: { ok: boolean; reason?: string } = { ok: true }) => {
        const resolve = vi.fn(async () => answer);
        const putBack = vi.fn();
        return { resolve, putBack, done: takeBackQueued({ pressed, promptId: 'p2', text: 'oops', composer: () => composer, resolve, putBack }) };
    };

    it('Withdraw with an empty composer: the host is asked to EDIT (no row kept), and the words come back without taking focus', async () => {
        const r = run('withdraw', draft('  '));
        expect(await r.done).toEqual({ ok: true, action: 'edit' });
        expect(r.resolve).toHaveBeenCalledWith('p2', 'edit');
        expect(r.putBack).toHaveBeenCalledWith('oops', false);
    });

    it('Withdraw with words in the composer: the host is asked to WITHDRAW (row kept, marked), and the composer is not touched', async () => {
        const r = run('withdraw', draft('half a thought'));
        expect(await r.done).toEqual({ ok: true, action: 'withdraw' });
        expect(r.resolve).toHaveBeenCalledWith('p2', 'withdraw');
        expect(r.putBack).not.toHaveBeenCalled();
    });

    it('Edit: the words come back into the composer, focused', async () => {
        const r = run('edit', draft('half a thought'));
        expect(await r.done).toEqual({ ok: true, action: 'edit' });
        expect(r.resolve).toHaveBeenCalledWith('p2', 'edit');
        expect(r.putBack).toHaveBeenCalledWith('oops', true);
    });

    it('lost the race: nothing goes to the composer, and the host\'s words are what the person is told', async () => {
        const r = run('edit', null, { ok: false, reason: 'Too late: the agent already has it.' });
        expect(await r.done).toEqual({ ok: false, reason: 'Too late: the agent already has it.' });
        expect(r.resolve).toHaveBeenCalledTimes(1);
        expect(r.putBack).not.toHaveBeenCalled();
    });

    it('an empty composer is no text (whitespace is none), no pill and no file', () => {
        expect(composerEmpty(null)).toBe(true);
        expect(composerEmpty(draft(' \n '))).toBe(true);
        expect(composerEmpty(draft('x'))).toBe(false);
        expect(composerEmpty(draft('', { attachments: [{ name: 'a.png' } as never] }))).toBe(false);
        expect(withdrawAction(null)).toBe('edit');
        expect(withdrawAction(draft('x'))).toBe('withdraw');
    });

    it('CONTROL: Undo send (#745) still holds a busy agent\'s message for its window and answers its words', () => {
        vi.useFakeTimers();
        try {
            const sent: string[] = [];
            const g = new SendGrace((h) => { sent.push(h.text); });
            const h = g.hold('a_worker', 'wrong agent');
            expect(g.undo(h.id)?.text).toBe('wrong agent');
            vi.advanceTimersByTime(10_000);
            expect(sent).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});
