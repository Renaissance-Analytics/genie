// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HangNotice } from '../src/core/crash-record.js';
import { HangNoticeBar } from '../src/renderer/components/HangNoticeBar.js';

/**
 * THE REOPENED WINDOW'S NOTICE (#1623 review; Tynn story #386) — not safe mode: the host never stopped, so nothing was
 * held back. "Genie's window stopped responding at <time> and was reopened. Your agents kept running." with "Send a crash
 * report". After a SECOND hang within 10 minutes it also offers "Stop all agents", listing what was running: one click,
 * the person's choice, never automatic; progress, then Stopped or the reason with Retry.
 */

const AT = Date.UTC(2026, 10, 6, 10, 0, 0);
const once: HangNotice = { at: AT, hangs: 1, agents: [{ id: 'agent_a', name: 'tynn' }, { id: 'agent_b', name: 'tynn-slave' }] };
const twice: HangNotice = { ...once, hangs: 2 };

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const q = <T extends Element>(sel: string) => host.querySelector(sel) as T | null;
const port = { draft: async () => ({ text: 'Genie crash report\nKind: hang' }), send: async () => ({ ok: true as const, issueUrl: 'https://github.com/x/fow-support/issues/1' }), copy: async () => true };

function render(notice: HangNotice | null, stopAll: () => Promise<{ ok: true } | { ok: false; reason: string }>, dismissed: number[] = []) {
    act(() => root.render(<HangNoticeBar notice={notice} clock={(at) => (at === AT ? '10:00 AM' : '?')} onStopAll={stopAll} onDismiss={async () => { dismissed.push(1); return { ok: true }; }} crashReport={port} />));
}

describe('the reopened-window notice', () => {
    it('says what happened and that the agents kept running, with Send a crash report; ONE hang offers no Stop all', () => {
        render(once, async () => ({ ok: true }));
        const bar = q<HTMLElement>('[data-hang-notice]')!;
        expect(bar.textContent).toContain('Genie’s window stopped responding at 10:00 AM and was reopened. Your agents kept running.');
        expect(q('[data-action="crash-report-open"]')?.textContent).toContain('Send a crash report');
        expect(q('[data-action="hang-stop-all"]')).toBeNull();
        expect(bar.textContent).not.toContain('tynn-slave');
    });

    it('nothing at all without a notice', () => {
        render(null, async () => ({ ok: true }));
        expect(q('[data-hang-notice]')).toBeNull();
    });

    it('a SECOND hang within 10 minutes: what was running, and Stop all agents — progress, then Stopped', async () => {
        let finish: (a: { ok: true }) => void = () => {};
        let asked = 0;
        render(twice, () => { asked++; return new Promise((r) => { finish = r; }); });
        const bar = q<HTMLElement>('[data-hang-notice]')!;
        expect(bar.textContent).toContain('tynn');
        expect(bar.textContent).toContain('tynn-slave');
        // Never automatic: nothing is stopped until the person presses it.
        expect(asked).toBe(0);
        const stop = q<HTMLButtonElement>('[data-action="hang-stop-all"]')!;
        expect(stop.textContent).toContain('Stop all agents');
        act(() => stop.click());
        expect(asked).toBe(1);
        expect(q<HTMLButtonElement>('[data-action="hang-stop-all"]')!.textContent).toContain('Stopping…');
        await act(async () => { finish({ ok: true }); await Promise.resolve(); });
        await flush();
        expect(q('[data-hang-outcome="stop-all"]')?.textContent).toContain('Stopped');
    });

    it('a stop that fails says why, with Retry', async () => {
        render(twice, async () => ({ ok: false, reason: 'the host did not answer' }));
        act(() => q<HTMLButtonElement>('[data-action="hang-stop-all"]')!.click());
        await flush();
        expect(q('[data-hang-outcome="stop-all"]')?.textContent).toContain('Not stopped: the host did not answer');
        expect(q<HTMLButtonElement>('[data-action="hang-stop-all"]')!.textContent).toContain('Retry');
    });

    it('Dismiss asks the host to forget it', async () => {
        const dismissed: number[] = [];
        render(once, async () => ({ ok: true }), dismissed);
        act(() => q<HTMLButtonElement>('[data-action="hang-notice-dismiss"]')!.click());
        await flush();
        expect(dismissed).toEqual([1]);
    });
});
