import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentChanges } from '../src/core/agent-changes.js';
import { attributionFrom, changedGroups, fileEventsOf } from '../src/core/files-panel.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE CHANGES TAB NEVER SHOWED THE AGENT'S CHANGES (the owner, 2026-10-14, on an agent that had edited files all day:
 * "No changes from tynn this session."). The rows below are the shape the owner's own ledger holds for one Claude Edit,
 * measured: a `tool_call` row with name and kind but no input yet, then `tool_call_update` rows with the input and the
 * status but no name or kind. 161 such edits in one session; none attributed.
 */
const root = '/w/tynn';
const t = (id: string, event: StreamEvent, at = 1_000): TimedEvent => ({ id, event, at });
const edit = (call: string, file: string): TimedEvent[] => [
    t(`${call}:0`, { kind: 'tool', toolCallId: call, name: 'Edit', title: null, status: 'pending', toolKind: 'edit', rawInput: null }),
    t(`${call}:1`, { kind: 'tool', toolCallId: call, name: null, title: null, status: 'in_progress', toolKind: null, rawInput: { file_path: `${root}/${file}`, old_string: 'a', new_string: 'a\nb' } }, 1_100),
    t(`${call}:2`, { kind: 'tool', toolCallId: call, name: null, title: null, status: 'completed', toolKind: null, rawInput: null }, 1_200),
];
const rows: TimedEvent[] = [
    t('a:0', { kind: 'turn', n: 1, by: 'you' }),
    ...edit('c1', 'src/A.php'),
    ...edit('c2', 'docs/B.md'),
    // A read of a third file is not a change.
    t('r:0', { kind: 'tool', toolCallId: 'r1', name: 'Read', title: null, status: 'pending', toolKind: 'read', rawInput: null }),
    t('r:1', { kind: 'tool', toolCallId: 'r1', name: null, title: null, status: 'completed', toolKind: null, rawInput: { file_path: `${root}/src/C.php` } }),
];
const tynn = { id: 'agent_t', name: 'tynn' };

describe('an agent’s changes, from its real row shape', () => {
    it('both edited files are attributed to the agent; the read is not a change', () => {
        const attribution = attributionFrom(fileEventsOf(rows, tynn), root);
        // COUNTED: exactly the two edited files.
        expect([...attribution.keys()].sort()).toEqual(['docs/B.md', 'src/A.php']);
        expect(attribution.get('src/A.php')).toMatchObject({ agents: [{ id: 'agent_t', name: 'tynn' }], inFlight: false, plus: 1, minus: 0 });
    });

    it('the Changes tab lists them under the agent', () => {
        const attribution = attributionFrom(fileEventsOf(rows, tynn), root);
        const changed = changedGroups(attribution, { mine: [], unreported: [] });
        expect(agentChanges({ changed }, 'tynn')?.slice().sort()).toEqual(['docs/B.md', 'src/A.php']);
    });

    it('an edit still running reads in flight', () => {
        const running = rows.filter((r) => r.id !== 'c2:2');
        expect(attributionFrom(fileEventsOf(running, tynn), root).get('docs/B.md')?.inFlight).toBe(true);
    });

    it('CONTROL: read row by row (as before), the same rows attribute nothing — the defect this fixes', () => {
        const naive = rows.flatMap((r) => (r.event.kind === 'tool' ? [{ agentId: 'agent_t', agentName: 'tynn', toolKind: r.event.toolKind, status: r.event.status, rawInput: r.event.rawInput, at: r.at }] : []));
        expect(attributionFrom(naive, root).size).toBe(0);
    });
});

describe('main uses it', () => {
    it('the file host’s eventsOf reads the agent’s rows through fileEventsOf', () => {
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
        expect(main.match(/eventsOf:[\s\S]{0,200}?fileEventsOf\(host\.rowsFor\(record\.id\)/g) ?? []).toHaveLength(1);
    });
});
