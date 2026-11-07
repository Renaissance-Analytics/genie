// @vitest-environment happy-dom
/**
 * THE SAFE-MODE BANNER, AS A PERSON SEES IT (spec §2; Tynn #386). On every window after an unclean end:
 * "Genie didn't shut down cleanly at <time> (<cause>). Nothing was started." — then what was running, each with its own
 * Start, and "Leave safe mode", which starts nothing by itself. Every action shows progress, then success or failure.
 *
 * Interaction is a claim about a live DOM, so this file renders in happy-dom.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeModeView } from '../src/core/safe-mode.js';
import { SafeModeBanner } from '../src/renderer/components/SafeModeBanner.js';

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const AT = Date.UTC(2026, 10, 6, 23, 12, 0);
const view = (over: Partial<SafeModeView> = {}): SafeModeView => ({
    active: true, at: AT, cause: 'unknown', crashLoop: false,
    agents: ['agent_a', 'agent_b'],
    processes: [{ id: 'proc_1', name: 'queue worker' }],
    sites: [{ id: 'site_shop', name: 'shop.gen' }],
    ...over,
});
const names: Record<string, string> = { agent_a: 'atlas', agent_b: 'tynn-slave' };
const startButton = (kind: string, id: string) => host.querySelector(`[data-action="safe-mode-start"][data-kind="${kind}"][data-id="${id}"]`) as HTMLButtonElement | null;
const leaveButton = () => host.querySelector('[data-action="safe-mode-leave"]') as HTMLButtonElement | null;

type Answer = { ok: true } | { ok: false; reason: string };
function deferred() {
    let settle: (a: Answer) => void = () => {};
    const promise = new Promise<Answer>((r) => { settle = r; });
    return { promise, settle };
}

function render(v: SafeModeView, handlers: { start?: (kind: 'agent' | 'process' | 'site', id: string) => Promise<Answer>; leave?: () => Promise<Answer> } = {}) {
    const start = vi.fn<(kind: 'agent' | 'process' | 'site', id: string) => Promise<Answer>>(handlers.start ?? (async () => ({ ok: true })));
    const leave = vi.fn<() => Promise<Answer>>(handlers.leave ?? (async () => ({ ok: true })));
    act(() => root.render(<SafeModeBanner view={v} agentName={(id) => names[id] ?? id} clock={() => '11:12 PM'} onStart={start} onLeave={leave} />));
    return { start, leave };
}

describe('the safe-mode banner', () => {
    it('says when, why, and that nothing was started; lists what was running, each with its own Start', () => {
        render(view());
        const banner = host.querySelector('[data-safe-mode]')!;
        expect(banner).not.toBeNull();
        expect(banner.textContent).toContain('Genie didn’t shut down cleanly at 11:12 PM (unknown). Nothing was started.');
        for (const word of ['atlas', 'tynn-slave', 'queue worker', 'shop.gen']) expect(banner.textContent).toContain(word);
        expect(startButton('agent', 'agent_a')).not.toBeNull();
        expect(startButton('agent', 'agent_b')).not.toBeNull();
        expect(startButton('process', 'proc_1')).not.toBeNull();
        expect(startButton('site', 'site_shop')).not.toBeNull();
        expect(leaveButton()?.textContent).toBe('Leave safe mode');
    });

    it('nothing at all out of safe mode', () => {
        render(view({ active: false }));
        expect(host.querySelector('[data-safe-mode]')).toBeNull();
    });

    it('a Start starts EXACTLY that one: progress while it runs, then Started', async () => {
        const answer = deferred();
        const r = render(view(), { start: () => answer.promise });
        act(() => startButton('agent', 'agent_b')!.click());
        expect(r.start).toHaveBeenCalledTimes(1);
        expect(r.start).toHaveBeenCalledWith('agent', 'agent_b');
        expect(r.leave).not.toHaveBeenCalled();
        expect(startButton('agent', 'agent_b')!.disabled).toBe(true);
        expect(startButton('agent', 'agent_b')!.textContent).toBe('Starting…');
        // CONTROL: the other rows are untouched.
        expect(startButton('agent', 'agent_a')!.disabled).toBe(false);
        await act(async () => { answer.settle({ ok: true }); await answer.promise; });
        expect(host.querySelector('[data-safe-mode-outcome="agent:agent_b"]')!.textContent).toBe('Started');
        expect(r.start).toHaveBeenCalledTimes(1);
    });

    it('a refused Start says why, and can be tried again', async () => {
        const r = render(view(), { start: async () => ({ ok: false, reason: 'the agent cap of 1 is reached' }) });
        await act(async () => { startButton('site', 'site_shop')!.click(); await Promise.resolve(); });
        expect(host.querySelector('[data-safe-mode-outcome="site:site_shop"]')!.textContent).toContain('the agent cap of 1 is reached');
        expect(startButton('site', 'site_shop')!.textContent).toBe('Retry');
        await act(async () => { startButton('site', 'site_shop')!.click(); await Promise.resolve(); });
        expect(r.start).toHaveBeenCalledTimes(2);
    });

    it('Leave safe mode starts NOTHING itself: it only asks to leave, with progress', async () => {
        const answer = deferred();
        const r = render(view(), { leave: () => answer.promise });
        act(() => leaveButton()!.click());
        expect(r.leave).toHaveBeenCalledTimes(1);
        expect(leaveButton()!.disabled).toBe(true);
        expect(leaveButton()!.textContent).toBe('Leaving…');
        await act(async () => { answer.settle({ ok: true }); await answer.promise; });
        expect(r.start).not.toHaveBeenCalled();
    });

    it('a Leave that fails says why', async () => {
        render(view(), { leave: async () => ({ ok: false, reason: 'Genie’s host is not connected' }) });
        await act(async () => { leaveButton()!.click(); await Promise.resolve(); });
        expect(host.querySelector('[data-safe-mode-outcome="leave"]')!.textContent).toContain('Genie’s host is not connected');
    });

    it('a crash loop says it stays until the person leaves it', () => {
        render(view({ crashLoop: true }));
        expect(host.querySelector('[data-safe-mode]')!.textContent).toMatch(/twice within 10 minutes/);
    });
});
