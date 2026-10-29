import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatAgentsKey } from '../src/core/chat-view.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { LedgerRowCache, type TimedEvent } from '../src/core/stream-view.js';
import { Stream } from '../src/renderer/components/Stream.js';
import { StreamRow } from '../src/renderer/components/StreamRow.js';

/**
 * A PUSH COSTS WHAT IT CHANGED (genie#1340; the owner, 2026-10-29: "I still get the ui lag when typing … it took 4
 * seconds before the text showed up").
 *
 * Measured in the real window on omarchy-test, eleven agents streaming and the person typing in the long thread's chat,
 * with history reads already bounded (the probe): the renderer was busy 76 s of 120. Every push — the watched agent's,
 * and the estate snapshot that any agent's activity sends 20 times a second — drew the whole Agent view again:
 *
 *  - each visible Stream row re-rendered, and formatted its time with `toLocaleTimeString`, which builds an ICU
 *    formatter per call: `timeOf` alone was 9.4 s of self time, the hottest function in the window;
 *  - every row was mapped through `ledgerRow` again into a NEW object (an edit's LCS diff counted again), so nothing
 *    downstream could tell an unchanged row from a changed one;
 *  - the chat's thread was derived again on every snapshot (6.3 s), because it depended on the whole agents list, which
 *    changes whenever any agent's status does — though it reads only their ids, names and fidelity.
 */
afterEach(() => vi.restoreAllMocks());

const at0 = Date.UTC(2026, 9, 29, 14, 7, 12);
const tool = (i: number): TimedEvent => ({ id: `r${i}`, at: at0 + i * 1000, event: { kind: 'tool', toolCallId: `c${i}`, name: 'Bash', title: `npm test ${i}`, status: 'completed', toolKind: 'execute', rawInput: { command: `npm test ${i}` } } });
const edit = (i: number): TimedEvent => ({ id: `e${i}`, at: at0 + i * 1000, event: { kind: 'tool', toolCallId: `x${i}`, name: 'Edit', title: 'Edit a.ts', status: 'completed', toolKind: 'edit', rawInput: { file_path: '/w/a.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' } } });

describe('a Stream row’s time', () => {
    it('is formatted by one shared formatter — never a toLocaleTimeString (an ICU formatter built) per row', () => {
        const perRow = vi.spyOn(Date.prototype, 'toLocaleTimeString');
        const html = renderToStaticMarkup(<Stream rows={Array.from({ length: 300 }, (_, i) => tool(i))} lanes={null} at={null} selectedId={null} onSelect={() => {}} />);
        expect(perRow).not.toHaveBeenCalled();
        perRow.mockRestore();
        // The same words as before: the viewer's own locale, 24-hour, with seconds.
        expect(html).toContain(`>${new Date(at0).toLocaleTimeString(undefined, { hour12: false })}<`);
    });
});

describe('the Stream’s rows across pushes', () => {
    it('an unchanged row is the SAME object on the next push; a changed one is new', () => {
        const cache = new LedgerRowCache();
        const a = tool(1);
        const b = edit(2);
        const first = [cache.row(a, { agentName: 'moic', durationMs: 1200 }), cache.row(b, { agentName: 'moic' })];
        const again = [cache.row(a, { agentName: 'moic', durationMs: 1200 }), cache.row(b, { agentName: 'moic' })];
        expect(again[0]).toBe(first[0]);
        expect(again[1]).toBe(first[1]);
        // What it says changed: a new row object (the host replaces a row that changed), or what its context says.
        expect(cache.row({ ...a }, { agentName: 'moic', durationMs: 1200 })).not.toBe(first[0]);
        expect(cache.row(a, { agentName: 'moic', durationMs: 1300 })).not.toBe(first[0]);
        expect(cache.row(a, { agentName: 'wren', durationMs: 1200 })).not.toBe(first[0]);
    });

    it('an edit’s diff is counted once per edit, not once per push', () => {
        const cache = new LedgerRowCache();
        const b = edit(2);
        const row = cache.row(b, { agentName: 'moic' });
        // The real diff of what the agent sent: one line changed, one added.
        expect([row.plus, row.minus]).toEqual([2, 1]);
        expect(cache.row(b, { agentName: 'moic' })).toBe(row);
    });

    it('a row draws again only when its props change (StreamRow is memoised)', () => {
        expect((StreamRow as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
    });
});

describe('the chat’s inputs from the estate snapshot', () => {
    const row = (id: string, name: string, status: string): AgentRow => ({ id, name, fidelity: 'declared', status } as unknown as AgentRow);
    it('do not change when only an agent’s status does — the chat reads ids, names and fidelity', () => {
        const before = [row('a1', 'moic', 'working'), row('a2', 'wren', 'idle')];
        const after = [row('a1', 'moic', 'idle'), row('a2', 'wren', 'working')];
        expect(chatAgentsKey(after)).toBe(chatAgentsKey(before));
    });

    it('change when a name, an agent or its fidelity does (positive control)', () => {
        const base = [row('a1', 'moic', 'idle')];
        expect(chatAgentsKey([row('a1', 'moic2', 'idle')])).not.toBe(chatAgentsKey(base));
        expect(chatAgentsKey([...base, row('a2', 'wren', 'idle')])).not.toBe(chatAgentsKey(base));
        expect(chatAgentsKey([{ ...base[0]!, fidelity: 'observed' } as AgentRow])).not.toBe(chatAgentsKey(base));
    });
});
