import { describe, expect, it } from 'vitest';
import type { ChatDraft } from '../src/core/chat-drafts.js';

/**
 * THE WINDOW'S HALF OF A PERSISTED DRAFT (genie#1261): what the chat's composers read their `defaultDraft` from, and what
 * writes each change to main — debounced, so typing is not a write per keystroke, except a send, which clears at once
 * (a quit a moment after sending must never bring the sent message back as a draft).
 *
 * Genie 1's renderer mirrored its question drafts into main the same way: a local copy is what the person types into,
 * main's copy is what a destroyed window or a restart comes back to (v0.7.0-beta.342 `renderer/pages/ask.tsx:127-153`,
 * `renderer/lib/ask-state.ts:14-16` "a draft belongs to the QUESTION, not to the modal").
 *
 * PURE: no DOM, no Electron. The port is main's IPC; the clock is injected.
 */
const keeperModule = () => import('../src/core/chat-draft-keeper.js');

const draft = (text: string, attachments: ChatDraft['attachments'] = []): ChatDraft => ({ v: 1, text, pills: [], attachments });

function harness(stored: Record<string, unknown> = {}) {
    const calls: Array<[string, ...unknown[]]> = [];
    const files = new Map<string, Uint8Array>();
    let n = 0;
    const port = {
        load: async () => stored,
        save: async (agentId: string, d: unknown) => { calls.push(['save', agentId, d]); },
        putFile: async (bytes: Uint8Array) => { const ref = `00000000-0000-4000-8000-00000000000${++n}`; files.set(ref, bytes); calls.push(['putFile', ref]); return ref; },
        readFile: async (ref: string) => files.get(ref) ?? null,
        release: async (refs: readonly string[]) => { calls.push(['release', [...refs]]); for (const r of refs) files.delete(r); },
    };
    const timers = new Map<number, () => void>();
    let id = 0;
    const clock = {
        setTimer: (fn: () => void) => { timers.set(++id, fn); return id; },
        clearTimer: (t: number) => { timers.delete(t); },
        fire: () => { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn(); },
        pending: () => timers.size,
    };
    return { port, calls, files, clock };
}

describe('load and restore', () => {
    it('not ready until main has answered; then each chat’s own draft, and nothing for a chat without one', async () => {
        const { ChatDraftKeeper } = await keeperModule();
        const h = harness({ a_lark: draft('to lark'), a_wren: { v: 7 } });
        const k = new ChatDraftKeeper(h.port, h.clock);
        expect(k.ready).toBe(false);
        await k.load();
        expect(k.ready).toBe(true);
        expect(k.initial('a_lark')).toEqual(draft('to lark'));
        expect(k.initial('a_wren')).toBeUndefined(); // a version this Genie does not know is not guessed at
        expect(k.initial('a_owl')).toBeUndefined();
    });

    it('main unreachable: ready anyway, with no drafts — the chat is never held hostage by its draft', async () => {
        const { ChatDraftKeeper } = await keeperModule();
        const h = harness();
        const k = new ChatDraftKeeper({ ...h.port, load: async () => { throw new Error('no main'); } }, h.clock);
        await k.load();
        expect(k.ready).toBe(true);
        expect(k.initial('a_lark')).toBeUndefined();
    });
});

describe('writes are debounced; a send clears that chat only', () => {
    it('typing: ONE save per pause, carrying the latest draft', async () => {
        const { ChatDraftKeeper } = await keeperModule();
        const h = harness();
        const k = new ChatDraftKeeper(h.port, h.clock);
        await k.load();
        k.change('a_lark', draft('h'));
        k.change('a_lark', draft('he'));
        k.change('a_lark', draft('hello'));
        expect(h.calls).toEqual([]);
        h.clock.fire();
        expect(h.calls).toEqual([['save', 'a_lark', draft('hello')]]);
        // And what a composer mounted later (a reload of the flyout) starts from is the latest, not what was loaded.
        expect(k.initial('a_lark')).toEqual(draft('hello'));
    });

    it('a send (the composer empties) clears THAT chat at once and cancels its pending write; the other chat keeps its draft and its own pending write', async () => {
        const { ChatDraftKeeper } = await keeperModule();
        const h = harness({ a_wren: draft('to wren') });
        const k = new ChatDraftKeeper(h.port, h.clock);
        await k.load();
        k.change('a_lark', draft('to lark'));
        k.change('a_wren', draft('to wren, more'));
        k.change('a_lark', draft(''));
        expect(h.calls).toEqual([['save', 'a_lark', null]]);
        expect(k.initial('a_lark')).toBeUndefined();
        h.clock.fire();
        // lark's stale 'to lark' never lands after the clear; wren's does.
        expect(h.calls).toEqual([['save', 'a_lark', null], ['save', 'a_wren', draft('to wren, more')]]);
        expect(k.initial('a_wren')).toEqual(draft('to wren, more'));
    });

    it('sent(): the sent message’s files are released, nothing else', async () => {
        const { ChatDraftKeeper } = await keeperModule();
        const h = harness();
        const k = new ChatDraftKeeper(h.port, h.clock);
        await k.load();
        const r1 = '00000000-0000-4000-8000-000000000001';
        const r2 = '00000000-0000-4000-8000-000000000002';
        k.sent('a_lark', [r1, r2]);
        await Promise.resolve();
        expect(h.calls).toEqual([['release', [r1, r2]]]);
        k.sent('a_lark', ['../../etc/passwd']); // not a ref main minted: never handed on
        k.sent('a_lark', []);
        await Promise.resolve();
        expect(h.calls).toHaveLength(1); // nothing to release, nothing sent to main
    });

    it('flush() (the window unloading — a reload) writes every pending draft now', async () => {
        const { ChatDraftKeeper } = await keeperModule();
        const h = harness();
        const k = new ChatDraftKeeper(h.port, h.clock);
        await k.load();
        k.change('a_lark', draft('to lark'));
        k.change('a_wren', draft('to wren'));
        k.flush();
        expect(h.calls).toEqual([['save', 'a_lark', draft('to lark')], ['save', 'a_wren', draft('to wren')]]);
        expect(h.clock.pending()).toBe(0);
    });
});

describe('attachments go through Genie’s own store, never inline', () => {
    it('persistFile hands main the bytes and returns main’s ref; restoreFile gets a File with those bytes, its name and type', async () => {
        const { ChatDraftKeeper } = await keeperModule();
        const h = harness();
        const k = new ChatDraftKeeper(h.port, h.clock);
        await k.load();
        const bytes = new Uint8Array([1, 2, 3, 250]);
        const ref = await k.persistFile(new File([bytes], 'shot.png', { type: 'image/png' }));
        expect(ref).toMatch(/^[0-9a-f-]{36}$/);
        expect(h.files.get(ref!)).toEqual(bytes);
        const file = await k.restoreFile({ id: 'i', name: 'shot.png', type: 'image/png', bytes: 4, ref: ref! });
        expect(file).toBeInstanceOf(File);
        expect(file!.name).toBe('shot.png');
        expect(file!.type).toBe('image/png');
        expect(new Uint8Array(await file!.arrayBuffer())).toEqual(bytes);
    });

    it('an entry with no ref, or bytes main no longer has: no File (the chip still shows; react-fancy’s contract)', async () => {
        const { ChatDraftKeeper } = await keeperModule();
        const h = harness();
        const k = new ChatDraftKeeper(h.port, h.clock);
        await k.load();
        expect(await k.restoreFile({ id: 'i', name: 'n', type: '', bytes: 1 })).toBeUndefined();
        expect(await k.restoreFile({ id: 'i', name: 'n', type: '', bytes: 1, ref: '00000000-0000-4000-8000-000000000009' })).toBeUndefined();
    });
});
