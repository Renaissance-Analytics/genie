import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import { ledgerRow, type TimedEvent } from '../src/core/stream-view.js';

/**
 * THE STREAM PER THE BOARD (`Agent View.dc.html`, re-audited 2026-10-12): a `kind` column (`Bash`, `Read`, `think`,
 * `usage`, `plan`, `compacted`) in mono before the main cell; message rows carry WHO spoke — `you`, the agent BY NAME,
 * a peer as `wren → atlas` — because rendering `role` alone once labelled a sibling agent's message `user`; an edit's
 * `+42` and `−8` are two coloured cells, not a string in the meta; a tool still running says `running` in amber, never
 * the protocol's raw `in_progress`.
 */
const at = 1_760_000_000_000;
const timed = (event: StreamEvent, id = 'e1'): TimedEvent => ({ id, event, at });
const tool = (over: Partial<Extract<StreamEvent, { kind: 'tool' }>> = {}): StreamEvent => ({
    kind: 'tool', toolCallId: 't1', name: 'Bash', title: 'php artisan test', status: null, toolKind: 'execute', rawInput: null, ...over,
});

describe('who spoke', () => {
    it('you in blue, the agent by NAME in violet, a peer as `peer → agent`; nothing on a non-message row', () => {
        const ctx = { agentName: 'atlas' };
        expect(ledgerRow(timed({ kind: 'message', speaker: 'you', peerName: null, text: 'hi' }), ctx).who).toEqual({ label: 'you', tone: 'you' });
        expect(ledgerRow(timed({ kind: 'message', speaker: 'agent', peerName: null, text: 'hi' }), ctx).who).toEqual({ label: 'atlas', tone: 'agent' });
        expect(ledgerRow(timed({ kind: 'message', speaker: 'peer', peerName: 'wren', text: 'hi' }), ctx).who).toEqual({ label: 'wren → atlas', tone: 'peer' });
        expect(ledgerRow(timed(tool()), ctx).who).toBeNull();
    });

    it('without the agent’s name it is still "the agent", never "user" or "assistant"', () => {
        expect(ledgerRow(timed({ kind: 'message', speaker: 'agent', peerName: null, text: 'hi' })).who).toEqual({ label: 'agent', tone: 'agent' });
    });
});

describe('the kind column', () => {
    it('names the tool, or the row’s own kind; null for a message; a nameless tool keeps its note and gets no kind', () => {
        expect(ledgerRow(timed(tool())).kind).toBe('Bash');
        expect(ledgerRow(timed(tool({ name: 'Edit', toolKind: 'edit', rawInput: { file_path: 'a.ts' } }))).kind).toBe('Edit');
        expect(ledgerRow(timed({ kind: 'think', text: 'hm', tokens: null })).kind).toBe('think');
        expect(ledgerRow(timed({ kind: 'usage', used: 1, size: 2, cost: null })).kind).toBe('usage');
        expect(ledgerRow(timed({ kind: 'plan', entries: [] })).kind).toBe('plan');
        expect(ledgerRow(timed({ kind: 'divider', variant: 'compaction', before: null, after: null })).kind).toBe('compacted');
        expect(ledgerRow(timed({ kind: 'message', speaker: 'you', peerName: null, text: 'hi' })).kind).toBeNull();
        const nameless = ledgerRow(timed(tool({ name: null, toolKind: null })));
        expect(nameless.kind).toBeNull();
        expect(nameless.note).toContain('kind not reported');
    });
});

describe('an edit’s line counts', () => {
    it('are two numbers from a real diff, not a string in the meta; absent (null) without one', () => {
        const edit = tool({ name: 'Edit', toolKind: 'edit', status: 'completed', rawInput: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } });
        const withDiff = ledgerRow(timed(edit), { diff: { plus: 42, minus: 8, newFile: false } });
        expect(withDiff.plus).toBe(42);
        expect(withDiff.minus).toBe(8);
        expect(withDiff.meta).toBe('applied');
        expect(withDiff.meta).not.toMatch(/[+−]\d/);
        const without = ledgerRow(timed(edit));
        expect(without.plus).toBeNull();
        expect(without.minus).toBeNull();
    });
});

describe('a running tool', () => {
    it('says `running` in amber — never the protocol’s raw status word', () => {
        for (const status of ['in_progress', 'pending'] as const) {
            const row = ledgerRow(timed(tool({ status })));
            expect(row.meta).toBe('running');
            expect(row.metaTone).toBe('warn');
        }
        // CONTROL: a finished one keeps `ok` / `err`.
        expect(ledgerRow(timed(tool({ status: 'completed' }))).meta).toBe('ok');
        expect(ledgerRow(timed(tool({ status: 'failed' }))).metaTone).toBe('bad');
    });
});
