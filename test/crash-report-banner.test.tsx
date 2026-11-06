// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SafeModeView } from '../src/core/safe-mode.js';
import { SafeModeBanner } from '../src/renderer/components/SafeModeBanner.js';

/**
 * "SEND A CRASH REPORT" ON THE SAFE-MODE BANNER (Tynn #386 part 4; spec §4). Never automatic: nothing is sent until the
 * person presses Send. They see the EXACT text, can edit it and say what they were doing; Send shows progress, then the
 * issue's link — or the reason with Retry. A Genie not signed in to Tynn cannot send through it: the banner says so in
 * one line and offers a Copy of the redacted report, never a silent failure.
 *
 * Interaction is a claim about a live DOM, so this file renders in happy-dom (docs/decisions.md D4).
 */
const view: SafeModeView = { active: true, at: Date.UTC(2026, 10, 6, 5, 12), cause: 'hang', crashLoop: false, agents: [], processes: [], sites: [] };
const REPORT = 'Genie crash report\nKind: hang\nGenie 2.0.0-beta.60 on linux x64';
type Sent = { text: string; notes: string };

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const q = <T extends Element>(sel: string) => host.querySelector(sel) as T | null;
const type = (el: HTMLTextAreaElement, value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
};

function render(answer: { ok: true; issueUrl: string } | { ok: false; reason: string; signIn?: boolean }, sent: Sent[], copied: string[] = []) {
    const crashReport = {
        draft: async () => ({ text: REPORT }),
        send: async (text: string, notes: string) => { sent.push({ text, notes }); return answer; },
        copy: async (text: string) => { copied.push(text); return true; },
    };
    act(() => root.render(<SafeModeBanner view={view} agentName={(id) => id} onStart={async () => ({ ok: true })} onLeave={async () => ({ ok: true })} {...({ crashReport } as Record<string, unknown>)} />));
}

describe('Send a crash report', () => {
    it('is offered, and NOTHING is sent until the person presses Send (COUNTED: 0, then 1)', async () => {
        const sent: Sent[] = [];
        render({ ok: true, issueUrl: 'https://github.com/Renaissance-Analytics/fow-support/issues/41' }, sent);
        const open = q<HTMLButtonElement>('[data-action="crash-report-open"]');
        expect(open?.textContent).toContain('Send a crash report');
        await act(async () => { open!.click(); });
        await flush();
        const text = q<HTMLTextAreaElement>('[data-crash-report-text]');
        expect(text?.value).toBe(REPORT);
        expect(q('[data-crash-report-notes]')).not.toBeNull();
        expect(sent).toHaveLength(0);
        // The person edits it and says what they were doing; what is sent is exactly that.
        await act(async () => { type(text!, `${REPORT}\nI had six agents running`); type(q<HTMLTextAreaElement>('[data-crash-report-notes]')!, 'opening the dashboard'); });
        await act(async () => { q<HTMLButtonElement>('[data-action="crash-report-send"]')!.click(); });
        await flush();
        expect(sent).toEqual([{ text: `${REPORT}\nI had six agents running`, notes: 'opening the dashboard' }]);
        const link = q<HTMLAnchorElement>('[data-crash-report-issue]');
        expect(link?.getAttribute('href')).toBe('https://github.com/Renaissance-Analytics/fow-support/issues/41');
    });

    it('Cancel discards it (nothing sent)', async () => {
        const sent: Sent[] = [];
        render({ ok: true, issueUrl: 'x' }, sent);
        await act(async () => { q<HTMLButtonElement>('[data-action="crash-report-open"]')!.click(); });
        await flush();
        await act(async () => { q<HTMLButtonElement>('[data-action="crash-report-cancel"]')!.click(); });
        expect(q('[data-crash-report-text]')).toBeNull();
        expect(sent).toHaveLength(0);
    });

    it('a refusal is said with Retry', async () => {
        const sent: Sent[] = [];
        render({ ok: false, reason: 'Tynn could not file the report on GitHub right now.' }, sent);
        await act(async () => { q<HTMLButtonElement>('[data-action="crash-report-open"]')!.click(); });
        await flush();
        await act(async () => { q<HTMLButtonElement>('[data-action="crash-report-send"]')!.click(); });
        await flush();
        expect(q('[data-crash-report-failure]')?.textContent).toContain('could not file');
        expect(q<HTMLButtonElement>('[data-action="crash-report-send"]')?.textContent).toContain('Retry');
    });

    it('not signed in to Tynn: one line saying so, and a Copy of the redacted report — never a silent failure', async () => {
        const sent: Sent[] = [];
        const copied: string[] = [];
        render({ ok: false, reason: 'not signed in', signIn: true }, sent, copied);
        await act(async () => { q<HTMLButtonElement>('[data-action="crash-report-open"]')!.click(); });
        await flush();
        await act(async () => { q<HTMLButtonElement>('[data-action="crash-report-send"]')!.click(); });
        await flush();
        expect(q('[data-crash-report-sign-in]')?.textContent).toBe('Sign in to Tynn to send this report');
        await act(async () => { q<HTMLButtonElement>('[data-action="crash-report-copy"]')!.click(); });
        await flush();
        expect(copied).toEqual([REPORT]);
    });
});
