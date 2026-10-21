import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { toStreamEvent, type StreamEvent } from '../src/core/stream-event.js';
import { ledgerRow, type TimedEvent } from '../src/core/stream-view.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { Stream } from '../src/renderer/components/Stream.js';

/**
 * A THOUGHT'S OWN TOKEN ESTIMATE (the board's `842 tok`, and the live row's running `412 tok`). prism-acp carries the
 * provider's estimate on each `agent_thought_chunk` under `_meta["particle.academy/thinking_tokens_estimate"]` — kept
 * out of `usage_update` because it is an ESTIMATE, not a measurement. Genie dropped it and showed instead an equal
 * share of the usage change between two reports (`Δ+…`), a derived guess. Now a thought with an estimate says so —
 * `~842 tok`, the tilde marking it as the provider's estimate — and only a thought without one keeps the Δ.
 */
const KEY = 'particle.academy/thinking_tokens_estimate';
const chunk = (text: string, estimate?: number) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, ...(estimate === undefined ? {} : { _meta: { [KEY]: estimate } }) });

describe('the wire', () => {
    it('reads the estimate off the chunk; a chunk without one has none (positive control)', () => {
        expect(toStreamEvent(chunk('a', 412))).toEqual({ kind: 'think', text: 'a', tokens: null, estimate: 412 });
        expect(toStreamEvent(chunk('a'))).toEqual({ kind: 'think', text: 'a', tokens: null, estimate: null });
    });
});

describe('one thought, the latest estimate', () => {
    const dirs: string[] = [];
    afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
    const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

    it('the joined thought carries the newest estimate; a chunk without one keeps the last', () => {
        const dir = mkdtempSync(join(tmpdir(), 'genie2-estimate-'));
        dirs.push(dir);
        let events: DriverEvents = {};
        const factory: SessionDriverFactory = (o) => { events = o.events; return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } }; };
        const rows: StreamEvent[] = [];
        const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: tree, onEvent: (e) => { rows.push(e); } });
        session.start();
        events.onUpdate?.(chunk('I should ', 120));
        events.onUpdate?.(chunk('read the tests', 412));
        events.onUpdate?.(chunk(' first.'));
        expect(rows.at(-1)).toEqual({ kind: 'think', text: 'I should read the tests first.', tokens: null, estimate: 412 });
    });
});

describe('the ledger and the live row', () => {
    const t = (id: string, event: StreamEvent, at: number): TimedEvent => ({ id, event, at });

    it('a thought with an estimate reads `~842 tok`; without one it keeps the derived Δ (positive control)', () => {
        expect(ledgerRow(t('k', { kind: 'think', text: 'x', tokens: null, estimate: 842 }, 1)).meta).toBe('~842 tok');
        expect(ledgerRow(t('k', { kind: 'think', text: 'x', tokens: 300, estimate: null }, 1)).meta).toBe('Δ+300 tok');
    });

    it('the live Thinking… row runs the estimate; with none it shows no figure', () => {
        const render = (estimate: number | null) => renderToStaticMarkup(
            <Stream rows={[t('t1', { kind: 'turn', n: 1, by: 'you' }, 1_000), t('k1', { kind: 'think', text: 'reading', tokens: null, estimate }, 1_200)]} lanes={null} at={null} selectedId={null} onSelect={() => {}} agentName="sable" live />,
        );
        expect(render(412)).toMatch(/data-live="thinking"[^>]*>[\s\S]*?Thinking…[\s\S]*?~412 tok/);
        expect(render(null)).not.toMatch(/\d+ tok/);
    });
});
