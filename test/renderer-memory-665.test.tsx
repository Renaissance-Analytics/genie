// @vitest-environment happy-dom
/**
 * THE WINDOW KEEPS ONE ESTATE, NOT ONE PER PUSH (Tynn #665). The #664 soak (owner-scale estate, Azure Windows): the
 * renderer heap at p50/p95/max 2,234/3,918/4,036 MB in 12 minutes, and out of memory twice at ~4.6 GB. The profile named
 * core/share.ts called from use-snapshot.ts on every estate push, then detailBytes (renderer/agent-detail.ts).
 *
 * - A push that arrives while the window has not drawn the last one must not be held by React as a queued update with its
 *   whole structured clone: main pushes up to twenty a second, and a window that is slow to draw (an owner-scale page,
 *   input coming first) held every one of them.
 * - Measuring the agent-detail cache must cost the rows a push ADDED, not the whole ledger again: the rows of a push are the
 *   rows the page already holds, by reference (core/agent-push-wire.ts), and a 6,000-row ledger was serialised per push.
 *
 * The retained bytes are read after a full GC (V8's own, exposed for this file), with a positive control in the same test:
 * the gauge reads the copies when something does hold them.
 */
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDetailCache, detailBytes } from '../src/renderer/agent-detail.js';
import { EMPTY_SNAPSHOT, type GenieBridge, type GenieSnapshot } from '../src/renderer/bridge.js';
import { useSnapshot } from '../src/renderer/use-snapshot.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const heapMb = (): number => { gc(); gc(); return process.memoryUsage().heapUsed / 1048576; };

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const AGENTS = 1500;
const text = (i: number): string => `Agent ${i} is reading the plan’s next step and the suite’s output before it writes. `.repeat(6);

/** An owner-scale estate as main sends it: a NEW object graph each push (a structured clone), one agent's state moved. */
function estate(push: number): GenieSnapshot {
    return structuredClone({
        ...EMPTY_SNAPSHOT,
        agents: Array.from({ length: AGENTS }, (_, i) => ({ id: `a${i}`, name: `agent-${i}`, workspaceId: 'ws', state: i === push % AGENTS ? 'working' : 'idle', reason: text(i), fixes: [] })),
        workspaces: [{ id: 'ws', path: '/w', name: 'w', agentsKnown: true }],
        deckItems: [],
    } as unknown as GenieSnapshot);
}

function fakeBridge(): { bridge: Pick<GenieBridge, 'snapshot' | 'subscribe'>; push: (s: GenieSnapshot) => void } {
    let listener: ((s: GenieSnapshot) => void) | null = null;
    return {
        bridge: { snapshot: async () => estate(0), subscribe: (fn) => { listener = fn; return () => { listener = null; }; } },
        push: (s) => listener!(s),
    };
}

describe('the window holds one estate, however many pushes wait to be drawn (Tynn #665)', () => {
    let host: HTMLElement;
    let root: Root;
    beforeEach(() => {
        g.IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); });

    it('forty pushes that arrive before the window draws retain about one estate, not forty, and the last one is drawn', async () => {
        const { bridge, push } = fakeBridge();
        const drawn: GenieSnapshot[] = [];
        function Window(): null {
            const s = useSnapshot(bridge);
            useLayoutEffect(() => { drawn.push(s); }, [s]);
            return null;
        }
        await act(async () => root.render(<Window />));
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(drawn.at(-1)?.agents.length).toBe(AGENTS);

        // POSITIVE CONTROL: the gauge reads forty estates when something holds them (one is several MB).
        const before = heapMb();
        const held = Array.from({ length: 40 }, (_, k) => estate(k + 1));
        const oneEstateMb = (heapMb() - before) / 40;
        expect(oneEstateMb).toBeGreaterThan(1);
        held.length = 0;

        // Forty pushes while React has not drawn: inside act, nothing renders until the callback returns.
        let retainedMb = Number.NaN;
        act(() => {
            const base = heapMb();
            for (let k = 1; k <= 40; k += 1) push(estate(k));
            retainedMb = heapMb() - base;
        });
        // About one estate (the newest's moved row and what main's clone shares nothing with), never forty.
        expect(retainedMb).toBeLessThan(oneEstateMb * 3);
        // And the window draws the LAST push, once it draws.
        const last = drawn.at(-1)!;
        expect(last.agents.find((a) => a.state === 'working')?.id).toBe('a40');
    });

    it('a push equal to what the window shows is not handed to React at all', async () => {
        const { bridge, push } = fakeBridge();
        let renders = 0;
        function Window(): null { useSnapshot(bridge); renders += 1; return null; }
        await act(async () => root.render(<Window />));
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        // POSITIVE CONTROL: a push that changed something draws.
        renders = 0;
        await act(async () => push(estate(7)));
        expect(renders).toBeGreaterThan(0);
        renders = 0;
        await act(async () => { for (let k = 0; k < 10; k += 1) push(estate(7)); });
        expect(renders).toBe(0);
    });
});

describe('measuring the agent-detail cache costs what a push added (Tynn #665)', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    const row = (i: number) => ({ id: `r${i}`, at: 1_700_000_000_000 + i, event: { kind: 'message', speaker: 'agent', text: text(i) } });
    const detail = (rows: readonly unknown[]) => ({ agent: { id: 'a_atlas' }, rows });

    it('fifty pushes of a 6,000-row ledger growing by one row serialise each row about once, and the bytes stay exact', () => {
        const cache = new AgentDetailCache<{ agent: { id: string }; rows: readonly unknown[] }>();
        let rows: unknown[] = Array.from({ length: 6000 }, (_, i) => row(i));
        cache.land('a_atlas', detail(rows));
        const stringify = vi.spyOn(JSON, 'stringify');
        let last = detail(rows);
        for (let k = 0; k < 50; k += 1) {
            // As the replica rebuilds it: the rows the page holds, by reference, and the new one.
            rows = [...rows, row(6000 + k)];
            last = detail(rows);
            cache.land('a_atlas', last);
        }
        const calls = stringify.mock.calls.length;
        stringify.mockRestore();
        // POSITIVE CONTROL: the push WAS measured (its new rows), and the total is the ledger's exact size.
        expect(calls).toBeGreaterThanOrEqual(50);
        expect(cache.bytes()).toBe(detailBytes(last));
        // Never the whole ledger per push (that was 50 x 6,000 = 300,000).
        expect(calls).toBeLessThan(500);
    });
});
