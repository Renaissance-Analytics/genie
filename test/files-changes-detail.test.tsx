import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { attributionFrom, type FileEvent } from '../src/core/files-panel.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE CHANGED ROWS' TIME AND COUNTS (the board's `Workspace Files`, Changed filter): a time column and `+n −m` per
 * file. Both from the agent's OWN report — the edit row's arrival time, and the lines in the call's before-and-after
 * (`old_string` / `new_string`) summed over the completed calls. Never estimated: a `Write` (no before-and-after)
 * leaves the counts absent, and a change nobody reported has neither. The marker names the agents on hover.
 */
const root = '/w/tynn';
const fmt = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const edit = (agent: string, file_path: string, status: 'in_progress' | 'completed', at: number | null, before?: string, after?: string): FileEvent =>
    ({ agentId: `agent_${agent}`, agentName: agent, toolKind: 'edit', status, at, rawInput: before === undefined ? { file_path } : { file_path, old_string: before, new_string: after } });

describe('attributionFrom — the time and the counts', () => {
    it('the latest reported edit’s time; the counts summed over completed calls with a real before-and-after', () => {
        const a = attributionFrom([
            edit('kora', '/w/tynn/src/a.ts', 'completed', 1_000, 'a\nb', 'a\nc\nd'),   // −1 +2
            edit('zane', '/w/tynn/src/a.ts', 'completed', 3_000, 'x', 'x\ny'),          // +1
            edit('kora', '/w/tynn/src/a.ts', 'in_progress', 5_000, 'q', 'r'),           // in flight: time counts, lines do not yet
        ], root);
        expect(a.get('src/a.ts')).toMatchObject({ changedAt: 5_000, plus: 3, minus: 1 });
    });

    it('a Write (no before-and-after) leaves the counts ABSENT, not zero; an untimed row leaves the time absent', () => {
        const a = attributionFrom([edit('kora', '/w/tynn/w.ts', 'completed', 2_000)], root);
        expect(a.get('w.ts')).toMatchObject({ changedAt: 2_000, plus: null, minus: null });
        const b = attributionFrom([edit('kora', '/w/tynn/u.ts', 'completed', null, 'a', 'b')], root);
        expect(b.get('u.ts')).toMatchObject({ changedAt: null, plus: 1, minus: 1 });
    });
});

describe('the panel', () => {
    const at = Date.UTC(2026, 9, 12, 14, 8);
    const state = {
        files: [{ path: 'src/a.ts', agents: [{ id: 'a1', name: 'kora' }, { id: 'a2', name: 'zane' }], count: 2, inFlight: false, changedAt: at, plus: 3, minus: 1 }],
        activity: [],
        unreported: ['notes.md'],
        changed: [{ who: 'kora', files: ['src/a.ts'] }, { who: '?', files: ['notes.md'] }],
    };
    const base: FilesPanelProps = {
        workspace: { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }, tree: [], state, tabs: [], open: null, pinned: false,
        onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {}, filter: 'changed', onFilter: () => {},
    };
    const html = renderToStaticMarkup(<FilesPanel {...base} />);

    it('a reported file: the time column, the path, +3 −1; the marker names the agents on hover', () => {
        const row = html.slice(html.indexOf('data-changed-file="src/a.ts"'), html.indexOf('data-changed-file="notes.md"'));
        expect(row).toContain(`data-changed-at="${at}"`);
        expect(row).toContain(fmt(at));
        expect(row).toContain('data-plus="3"');
        expect(row).toContain('data-minus="1"');
        expect(row).toContain('title="kora, zane"');
    });

    it('an unreported file: no time, no counts, the `?` marker (positive control for the absences above)', () => {
        const row = html.slice(html.indexOf('data-changed-file="notes.md"'));
        expect(row).not.toContain('data-changed-at');
        expect(row).not.toContain('data-plus');
        expect(row).not.toContain('data-minus');
        expect(row).toContain('data-file-marker="notes.md"');
    });
});
