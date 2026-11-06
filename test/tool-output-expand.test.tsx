// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import { joinToolCalls, ledgerRow, type TimedEvent } from '../src/core/stream-view.js';
import { StreamRow } from '../src/renderer/components/StreamRow.js';

/**
 * A TOOL ROW'S WHOLE OUTPUT IS FETCHED WHEN A PERSON EXPANDS IT (Tynn story #386, spec §3).
 *
 * The window holds a tool's preview only (at most 16 KB); the whole answer stays in the host's sidecar. Expanding the
 * row shows the preview at once and fetches the whole, saying so while it loads, and a failure says why with a Retry.
 * A row whose whole was never kept (an old ledger's) shows its preview and says the rest was not kept; nothing fetched.
 */
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

const t = (id: string, event: StreamEvent, at: number): TimedEvent => ({ id, event, at });
type Tool = Extract<StreamEvent, { kind: 'tool' }>;
const call = (over: Partial<Tool> & Record<string, unknown>): TimedEvent[] => joinToolCalls([
    t('r1', { kind: 'tool', toolCallId: 'call_1', name: 'exec', title: 'Run the build', status: 'in_progress', toolKind: 'execute', rawInput: { command: 'make all' } }, 1_000),
    t('r2', { kind: 'tool', toolCallId: 'call_1', name: null, title: null, status: 'completed', toolKind: null, rawInput: null, ...over } as Tool, 2_000),
]);
const PREVIEW = 'HEAD-OF-THE-OUTPUT preview lines';
const WHOLE = `${PREVIEW} … TAIL-OF-THE-OUTPUT`;

type Reply = { ok: true; text: string; bytes: number; cut: boolean } | { ok: false; reason: string };
function render(row: ReturnType<typeof ledgerRow>, expanded: boolean, loadFull: (toolCallId: string) => Promise<Reply>, onToggle = vi.fn()) {
    // `loadFull` is the new prop; reached loosely so the old component is red by assertion, not by a type error.
    const props = { row, selected: false, expanded, onToggle, onSelect: () => {}, loadFull } as Parameters<typeof StreamRow>[0];
    act(() => root.render(<StreamRow {...props} />));
    return onToggle;
}

describe('a tool row with output', () => {
    it('is expandable; the row the window holds carries the preview, and names the whole only when it was kept', () => {
        const [joined] = call({ output: PREVIEW, outputBytes: 240_000, outputFile: 'tool-call_1.out' });
        const row = ledgerRow(joined!) as ReturnType<typeof ledgerRow> & { toolOutput?: { text: string; toolCallId: string; whole: number | null } };
        expect(row.expandable).toBe(true);
        expect(row.toolOutput).toEqual({ text: PREVIEW, toolCallId: 'call_1', whole: 240_000 });
        const [old] = call({ output: PREVIEW, outputBytes: 240_000 });
        expect((ledgerRow(old!) as typeof row).toolOutput).toEqual({ text: PREVIEW, toolCallId: 'call_1', whole: null });
        // A call that answered nothing has nothing to open.
        const [silent] = call({});
        expect(ledgerRow(silent!).expandable).toBe(false);
    });

    it('expanding fetches the whole output from the host and shows it; collapsed, nothing is fetched', async () => {
        const [joined] = call({ output: PREVIEW, outputBytes: 240_000, outputFile: 'tool-call_1.out' });
        const row = ledgerRow(joined!);
        let answer: (r: Reply) => void = () => {};
        const loadFull = vi.fn((_id: string) => new Promise<Reply>((resolve) => { answer = resolve; }));
        const onToggle = render(row, false, loadFull);
        expect(loadFull).not.toHaveBeenCalled();
        const button = host.querySelector('[data-expandable="true"]') as HTMLElement | null;
        expect(button).not.toBeNull();
        act(() => button!.click());
        expect(onToggle).toHaveBeenCalledWith(row.id);

        render(row, true, loadFull, onToggle);
        expect(loadFull).toHaveBeenCalledTimes(1);
        expect(loadFull).toHaveBeenCalledWith('call_1');
        // At once: the preview, and that the whole is on its way.
        expect(host.textContent).toContain(PREVIEW);
        expect(host.querySelector('[data-tool-output-loading]')).not.toBeNull();
        await act(async () => { answer({ ok: true, text: WHOLE, bytes: WHOLE.length, cut: false }); await Promise.resolve(); });
        await flush();
        expect(host.querySelector('[data-tool-output]')?.textContent).toContain('TAIL-OF-THE-OUTPUT');
        expect(host.querySelector('[data-tool-output-loading]')).toBeNull();
    });

    it('a failed fetch says why and offers Retry, which asks again', async () => {
        const [joined] = call({ output: PREVIEW, outputBytes: 240_000, outputFile: 'tool-call_1.out' });
        const row = ledgerRow(joined!);
        const loadFull = vi.fn()
            .mockResolvedValueOnce({ ok: false, reason: 'the output file could not be read' })
            .mockResolvedValueOnce({ ok: true, text: WHOLE, bytes: WHOLE.length, cut: false });
        render(row, true, loadFull);
        await flush();
        expect(host.textContent).toContain('the output file could not be read');
        const retry = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Retry');
        expect(retry).toBeDefined();
        await act(async () => { retry!.click(); await Promise.resolve(); });
        await flush();
        expect(loadFull).toHaveBeenCalledTimes(2);
        expect(host.querySelector('[data-tool-output]')?.textContent).toContain('TAIL-OF-THE-OUTPUT');
    });

    it('an old row whose whole was not kept shows its preview and says so; nothing is fetched', async () => {
        const [old] = call({ output: PREVIEW, outputBytes: 240_000 });
        const loadFull = vi.fn();
        render(ledgerRow(old!), true, loadFull);
        await flush();
        expect(loadFull).not.toHaveBeenCalled();
        expect(host.querySelector('[data-tool-output]')?.textContent).toContain(PREVIEW);
        expect(host.querySelector('[data-tool-output-not-kept]')).not.toBeNull();
    });
});
