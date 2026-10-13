import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import { joinToolCalls, ledgerRow, type TimedEvent } from '../src/core/stream-view.js';
import { Stream } from '../src/renderer/components/Stream.js';

/**
 * ONE ROW PER TOOL CALL (the owner's screenshot, using beta.19: `Grep Grep · running`, then `(tool call) (kind not
 * reported) running`, `(tool call) … ok`, again and again). A call arrives as a `tool_call` and then its
 * `tool_call_update`s, which carry the same toolCallId and usually no name, title or kind. Each update became its own
 * nameless row, and the call's own row stayed `running` for ever. Now the updates fold into the call's row — its
 * name, title, kind and input from the first that said them, its status the latest — and a title that only repeats
 * the tool's name is said once.
 */
const t = (id: string, event: StreamEvent, at: number): TimedEvent => ({ id, event, at });
const tool = (id: string, callId: string, over: Partial<Extract<StreamEvent, { kind: 'tool' }>>, at: number) =>
    t(id, { kind: 'tool', toolCallId: callId, name: null, title: null, status: 'pending', toolKind: null, rawInput: null, ...over }, at);

const rows: TimedEvent[] = [
    tool('r1', 'c1', { name: 'Grep', title: 'Grep', status: 'in_progress', toolKind: 'search', rawInput: { pattern: 'Challenge' } }, 1_000),
    tool('r2', 'c1', { status: 'in_progress' }, 1_200),
    t('r3', { kind: 'think', text: 'checking', tokens: null }, 1_300),
    tool('r4', 'c1', { status: 'completed' }, 2_200),
    tool('r5', 'c2', { name: 'Read', title: 'src/a.ts', status: 'in_progress', toolKind: 'read' }, 2_300),
];

describe('joinToolCalls', () => {
    it('folds every update into the call\'s own row, where the call was; the latest status wins', () => {
        const joined = joinToolCalls(rows);
        expect(joined.map((r) => r.id)).toEqual(['r1', 'r3', 'r5']);
        expect(joined[0]!.event).toMatchObject({ kind: 'tool', toolCallId: 'c1', name: 'Grep', title: 'Grep', status: 'completed', toolKind: 'search', rawInput: { pattern: 'Challenge' } });
        expect(joined[0]!.at).toBe(1_000);
    });

    it('an update whose call never arrived keeps its own row (nothing is dropped)', () => {
        expect(joinToolCalls([tool('u', 'c9', { status: 'completed' }, 5)]).map((r) => r.id)).toEqual(['u']);
    });
});

describe('the row', () => {
    it('says a title that only repeats the tool\'s name once', () => {
        expect(ledgerRow(rows[0]!).main).toBe('Grep');
        expect(ledgerRow(rows[4]!).main).toBe('Read  src/a.ts');
    });

    it('in the Stream: one Grep row, finished, with its duration; no nameless rows', () => {
        const html = renderToStaticMarkup(<Stream rows={rows} lanes={null} at={null} selectedId={null} onSelect={() => {}} agentName="moic" />);
        expect(html.match(/data-stream-row="/g)).toHaveLength(3);
        expect(html).not.toContain('(tool call)');
        expect(html).not.toContain('Grep  Grep');
        expect(html).toMatch(/data-stream-row="r1"[\s\S]*?ok · 1\.2s/);
    });
});
