// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RendererNotice } from '../src/core/renderer-notice.js';
import { RendererNoticeBar } from '../src/renderer/components/RendererNoticeBar.js';

/*
 * THE BROUGHT-BACK PAGE'S NOTICE (Tynn #386; main/renderer-recovery.ts): "Genie's window ran out of memory and was reloaded
 * at 3:04 PM. Your agents kept running." with "Send a crash report", and Dismiss. Nothing at all without a notice.
 */
const AT = Date.UTC(2026, 10, 6, 21, 4, 35);
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const port = { draft: async () => ({ text: 'Genie crash report' }), send: async () => ({ ok: true as const, issueUrl: 'https://example.invalid/1' }), copy: async () => true };
const render = (notice: RendererNotice | null, dismissed: number[] = []) => act(() => root.render(
    <RendererNoticeBar notice={notice} clock={(at) => (at === AT ? '3:04 PM' : '?')} onDismiss={async () => { dismissed.push(1); return { ok: true }; }} crashReport={port} />,
));

describe('the brought-back page says so', () => {
    it('out of memory: when, that the agents kept running, and Send a crash report', () => {
        render({ at: AT, reason: 'oom', rendererMb: 812, reloads: 1 });
        const bar = host.querySelector('[data-renderer-notice]');
        expect(bar?.getAttribute('data-renderer-notice')).toBe('oom');
        expect(bar?.textContent).toContain("Genie's window ran out of memory and was reloaded at 3:04 PM. Your agents kept running.");
        expect(host.querySelector('[data-action="crash-report-open"]')).not.toBeNull();
    });

    it('a crash and a kill read as such', () => {
        render({ at: AT, reason: 'crashed', rendererMb: null, reloads: 2 });
        expect(host.textContent).toContain("Genie's window crashed and was reloaded at 3:04 PM.");
        render({ at: AT, reason: 'killed', rendererMb: null, reloads: 2 });
        expect(host.textContent).toContain("Genie's window was ended by the system and was reloaded at 3:04 PM.");
    });

    it('Dismiss asks the window to forget it; CONTROL: no notice, nothing shown', async () => {
        const dismissed: number[] = [];
        render({ at: AT, reason: 'oom', rendererMb: 812, reloads: 1 }, dismissed);
        await act(async () => { (host.querySelector('[data-action="renderer-notice-dismiss"]') as HTMLButtonElement).click(); await Promise.resolve(); });
        expect(dismissed).toEqual([1]);
        render(null);
        expect(host.querySelector('[data-renderer-notice]')).toBeNull();
    });
});
