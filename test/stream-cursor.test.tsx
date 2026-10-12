import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { inspectorOnEnter, stepRow } from '../src/core/keys.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { Workspace } from '../src/renderer/components/Workspace.js';
import { ICON_NAMES } from '../src/renderer/icons.js';

/**
 * THE STREAM CURSOR (§4.2): `j`/`k` move a cursor; `↵` opens or closes the Inspector on it. Before this, the cursor
 * WAS the selection — every step opened the Inspector on whatever it landed on, and Enter could only close. Now the
 * cursor is a focus (a ring on the row), Enter is the one key that opens, and a row that cannot be inspected is not a
 * control. And the workspace header's Files button per the board: `folder-tree` · Files · ⌘B.
 */
describe('inspectorOnEnter', () => {
    const inspectable = (id: string) => id.startsWith('edit');

    it('opens the cursor row when it can be inspected; closes the row already open; nothing on a plain row', () => {
        expect(inspectorOnEnter('edit1', null, inspectable)).toEqual({ open: 'edit1' });
        expect(inspectorOnEnter('edit1', 'edit2', inspectable)).toEqual({ open: 'edit1' });
        expect(inspectorOnEnter('edit1', 'edit1', inspectable)).toBe('close');
        expect(inspectorOnEnter('think1', null, inspectable)).toBeNull();
        expect(inspectorOnEnter('think1', 'edit1', inspectable)).toBeNull();
    });

    it('with no cursor yet: closes what is open, or nothing', () => {
        expect(inspectorOnEnter(null, 'edit1', inspectable)).toBe('close');
        expect(inspectorOnEnter(null, null, inspectable)).toBeNull();
    });

    it('the cursor steps without opening — stepRow is a pure move over the visible ids', () => {
        expect(stepRow(['a', 'b', 'c'], 'a', 'next')).toBe('b');
        expect(stepRow(['a', 'b', 'c'], null, 'prev')).toBe('c');
    });
});

describe('the cursor in the Agent view', () => {
    const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
    const t = (id: string, event: StreamEvent, at: number | null): TimedEvent => ({ id, event, at });
    const rows: TimedEvent[] = [
        t('a1:0', { kind: 'turn', n: 1, by: 'you' }, 1_000),
        t('a1:1', { kind: 'think', text: 'hmm', tokens: null }, 1_200),
        t('a1:2', { kind: 'tool', toolCallId: 'c1', name: 'Edit', title: null, status: 'completed', toolKind: 'edit', rawInput: { file_path: '/w/tynn/a.ts', old_string: 'a', new_string: 'b' } }, 1_500),
    ];
    const working: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
    const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
        renderToStaticMarkup(<AgentView agent={agent} session={working} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

    it('a cursor row carries data-cursor and is NOT selected; the selected row is a different mark', () => {
        const html = render({ cursor: 'a1:1', selectedId: 'a1:2' });
        expect(html).toMatch(/data-stream-row="a1:1"[^>]*data-selected="false"[^>]*data-cursor="true"/);
        expect(html).toMatch(/data-stream-row="a1:2"[^>]*data-selected="true"(?![^>]*data-cursor)/);
        expect((html.match(/data-cursor="true"/g) ?? []).length).toBe(1);
    });

    it('no cursor given: no row carries the mark (positive control for the one above)', () => {
        expect(render()).not.toContain('data-cursor');
    });
});

describe('the Files button (the board: `folder-tree` · Files · ⌘B)', () => {
    it('`folder-tree` is a registered icon', () => {
        expect(ICON_NAMES).toContain('folder-tree');
    });

    it('the workspace header button draws the icon, the word and the chord', () => {
        const html = renderToStaticMarkup(<Workspace view="terminals" workspace={{ id: 'tynn', name: 'tynn', path: '/w/tynn' }} terminals={NO_TERMINALS} files={{} as never} panel={null} onTogglePanel={() => {}} />);
        const start = html.indexOf('data-action="toggle-files"');
        expect(start).toBeGreaterThan(-1);
        const button = html.slice(start, html.indexOf('</button>', start));
        // The icon itself renders only once the registry is loaded (the icons census proves the name is registered
        // and that the JSX asks for it); here the word and the chord, and the button's new flex chrome.
        expect(button).toContain('Files');
        expect(button).toContain('⌘B');
        expect(button).toMatch(/class="[^"]*flex items-center gap-1\.5/);
    });
});
