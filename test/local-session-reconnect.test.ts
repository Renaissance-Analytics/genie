import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { localSession } from '../src/renderer/local-session.js';

/*
 * ONE DROPPED LINK MUST NOT LEAVE THE WINDOW REFUSING EVERYTHING (Tynn #590). The owner: every change in agent settings
 * answered "The connection to Genie closed. Retry to reconnect." and there was no Retry where he was looking. The window's
 * link to its host now comes back on its own, with backoff and with no limit on how long it keeps trying; a change made
 * during the drop waits and applies; and nothing tells the person to press a button that is not there.
 */

interface Call { kind: string; id: number; method: string; args: unknown[] }

function door() {
    const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
    const active = new Set<string>();
    const opened: number[] = [];
    const calls: Call[] = [];
    let accepting = true;
    let holdCalls = false;
    const held: Array<() => void> = [];
    let replyWith: (call: Call) => unknown = () => ({ ok: true });
    const emit = (action: 'frame' | 'closed', handle: string, text: string) => { for (const l of listeners) l(action, handle, text); };
    const port: LocalFramePort = {
        onFrame: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        send: (action, handle, text) => {
            if (action === 'open') { opened.push(Date.now()); active.add(handle); return; }
            if (action === 'close') { active.delete(handle); return; }
            const frame = JSON.parse(text) as Call;
            queueMicrotask(() => {
                if (frame.kind === 'hello') {
                    if (accepting) emit('frame', handle, JSON.stringify({ kind: 'welcome', connectionId: handle, host: 'this Genie', isOwner: true, workspaceId: null }));
                    else { emit('frame', handle, JSON.stringify({ kind: 'refused', reason: 'Genie is still starting' })); active.delete(handle); emit('closed', handle, 'Genie is still starting'); }
                    return;
                }
                calls.push(frame);
                const answer = () => emit('frame', handle, JSON.stringify({ kind: 'result', id: frame.id, ok: true, value: replyWith(frame) }));
                if (holdCalls) held.push(answer); else answer();
            });
        },
    };
    return {
        port, opened, calls, active,
        accept: (on: boolean) => { accepting = on; },
        hold: () => { holdCalls = true; },
        reply: (fn: (call: Call) => unknown) => { replyWith = fn; },
        drop: (reason = 'the local window reloaded or navigated') => { for (const h of [...active]) { active.delete(h); emit('closed', h, reason); } },
        event: (channel: string, payload: unknown) => { for (const h of active) emit('frame', h, JSON.stringify({ kind: 'event', channel, payload })); },
    };
}

/** Everything the session has queued up to this moment, on the fake clock. */
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

async function connected() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const d = door();
    const session = localSession(d.port);
    await tick();
    expect(session.control.state().phase).toBe('ready');
    return { d, session };
}

afterEach(() => { vi.useRealTimers(); });

describe('a dropped link comes back by itself', () => {
    it('it is never failed: it reconnects, and what was read is read again', async () => {
        const { d, session } = await connected();
        d.drop();
        await tick();
        expect(session.control.state().phase).not.toBe('failed');
        await tick(250);
        expect(d.opened).toHaveLength(2);
        expect(session.control.state()).toEqual({ phase: 'ready', reason: null, revision: 1 });
    });

    it('with backoff, and with no limit on how long it keeps trying', async () => {
        const { d, session } = await connected();
        d.accept(false);
        const start = Date.now();
        d.drop();
        await tick(10 * 60_000);
        expect(session.control.state().phase).not.toBe('failed');
        const gaps = d.opened.slice(1).map((at, i) => at - (i === 0 ? start : d.opened[i]!));
        expect(gaps.slice(0, 5)).toEqual([250, 500, 1_000, 2_000, 5_000]);
        expect(Math.max(...gaps)).toBe(5_000);
        expect(d.opened.length).toBeGreaterThan(100);
        d.accept(true);
        await tick(5_000);
        expect(session.control.state().phase).toBe('ready');
    });

    it('a second drop is recovered the same way', async () => {
        const { d, session } = await connected();
        d.drop(); await tick(250);
        expect(session.control.state().phase).toBe('ready');
        d.drop(); await tick(250);
        expect(session.control.state()).toMatchObject({ phase: 'ready', revision: 2 });
    });

    it('what was subscribed is subscribed again on the new link', async () => {
        const { d, session } = await connected();
        const settings: string[] = [];
        session.workspaces.onSettingsChanged!((id) => { settings.push(id); });
        const updates = vi.fn();
        session.updates.subscribe(updates);
        const before = d.calls.length;
        d.drop();
        await tick(250);
        d.event('workspace-settings-changed', 'work');
        expect(settings).toEqual(['work']);
        expect(d.calls.length).toBeGreaterThanOrEqual(before);
        d.event('local-updates', { phase: 'idle' });
        expect(updates).toHaveBeenCalledWith({ phase: 'idle' });
    });

    it('a subscription dropped during the outage is not brought back (CONTROL)', async () => {
        const { d, session } = await connected();
        const updates = vi.fn();
        const off = session.updates.subscribe(updates);
        d.drop();
        off();
        await tick(250);
        d.event('local-updates', { phase: 'idle' });
        expect(updates).not.toHaveBeenCalled();
    });
});

describe('a change made during the drop', () => {
    it('waits and applies once the link is back', async () => {
        const { d, session } = await connected();
        d.drop();
        const change = session.agents.setIssueWatch('atlas', { delivery: 'off', kinds: [] });
        await tick(250);
        expect(await change).toEqual({ ok: true });
        expect(d.calls.map((c) => c.method)).toEqual(['agents.setIssueWatch']);
    });

    it('if the link has not come back in 15 s it says so, without promising a button', async () => {
        const { d, session } = await connected();
        d.accept(false);
        d.drop();
        const change = session.agents.setIssueWatch('atlas', { delivery: 'off', kinds: [] });
        await tick(15_000);
        const answer = await change as { ok: false; reason: string };
        expect(answer.ok).toBe(false);
        expect(answer.reason).not.toMatch(/retry/i);
        expect(answer.reason.length).toBeGreaterThan(0);
        expect(d.calls).toEqual([]);
    });

    it('that same call made after it comes back goes through (CONTROL)', async () => {
        const { d, session } = await connected();
        d.accept(false);
        d.drop();
        await tick(20_000);
        d.accept(true);
        await tick(5_000);
        expect(await session.agents.setIssueWatch('atlas', { delivery: 'off', kinds: [] })).toEqual({ ok: true });
    });

    it('a change already sent when the link went is reported failed, never re-sent, since it may have landed', async () => {
        const { d, session } = await connected();
        d.hold();
        const change = session.agents.setIssueWatch('atlas', { delivery: 'off', kinds: [] });
        await tick();
        expect(d.calls).toHaveLength(1);
        d.drop();
        expect(await change).toMatchObject({ ok: false });
        await tick(250);
        expect(d.calls).toHaveLength(1);
    });
});

describe('what stays as it was', () => {
    it('another connection taking this window\'s place is not fought for: it needs the person', async () => {
        const { d, session } = await connected();
        d.drop('this window opened a replacement protocol connection');
        await tick(60_000);
        expect(d.opened).toHaveLength(1);
        expect(session.control.state()).toMatchObject({ phase: 'failed' });
        session.control.retry();
        await tick();
        expect(session.control.state().phase).toBe('ready');
    });

    it('nothing in the window tells the person to Retry a dropped link', () => {
        expect(readFileSync('src/renderer/local-session.ts', 'utf8')).not.toContain('Retry to reconnect');
    });
});
