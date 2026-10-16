import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * ON SCREEN: the tab note right of the tabs; the Inspector's diff header (`+1 −0 · time · edit 1 of 1`) and its
 * footer door `Open in workspace files`. `Revert this edit` is a write Genie does not make yet and is not drawn.
 */
const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const working: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const NOW = 1_760_000_100_000;
const t = (id: string, event: StreamEvent, at: number): TimedEvent => ({ id, event, at });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }, NOW - 50_000),
    t('a1:1', { kind: 'tool', toolCallId: 'c1', name: 'Edit', title: null, status: 'completed', toolKind: 'edit', rawInput: { file_path: '/w/tynn/a.ts', old_string: 'a', new_string: 'a\nb' } }, NOW - 30_000),
];
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={working} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => NOW} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

describe('the tab note', () => {
    it('on the Stream: the live count; on Files: where it opens', () => {
        // Two timed rows inside the window: the turn marker 50 s ago and the edit 30 s ago — the span runs from the earliest.
        expect(render()).toMatch(/data-tab-note="live"[^>]*>2 events in the last 50s</);
        expect(render({ tab: 'files' })).toMatch(/data-tab-note="files"[^>]*>Files and Changes open the workspace file panel, filtered to atlas</);
    });
});

describe('the diff header and footer', () => {
    it('counts, time and place above the diff; Open in workspace files below', () => {
        const html = render({ selectedId: 'a1:1' });
        expect(html).toContain('data-inspector="diff"');
        expect(html).toMatch(/data-diff-header[^>]*>[\s\S]*?\+1[\s\S]*?edit 1 of 1/);
        expect(html).not.toMatch(/data-diff-header[^>]*>[\s\S]*?−0/);
        expect(html).toMatch(/data-action="open-in-files"[^>]*data-nav="genie:\/\/agent\/a1\?tab=files"/);
        expect(html).not.toContain('Revert this edit');
    });
});
