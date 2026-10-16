import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { LiveSession } from '../src/core/roster.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { Stream } from '../src/renderer/components/Stream.js';

/**
 * THE STREAM ROWS ON SCREEN PER THE BOARD: a 40px mono kind column; a message's speaker label in its colour above the
 * text; `+42` green and `−8` red as cells; and, when the turn did not finish, an inline error card at the end of the
 * stream — `ACP stream closed · exit 137` with "The turn did not finish. The last tool call has no result."
 */
const at = 1_760_000_000_000;
const timed = (event: StreamEvent, id: string): TimedEvent => ({ id, event, at });
const rows: TimedEvent[] = [
    timed({ kind: 'message', speaker: 'you', peerName: null, text: 'Use the cache driver.' }, 'm1'),
    timed({ kind: 'message', speaker: 'peer', peerName: 'wren', text: 'drop the table' }, 'm2'),
    timed({ kind: 'tool', toolCallId: 't1', name: 'Bash', title: 'php artisan test', status: 'in_progress', toolKind: 'execute', rawInput: null }, 't1'),
    timed({ kind: 'tool', toolCallId: 't2', name: 'Edit', title: 'src/a.ts', status: 'completed', toolKind: 'edit', rawInput: { file_path: 'src/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' } }, 't2'),
];

describe('the rows', () => {
    it('kind column, speaker labels, and the edit’s ± cells', () => {
        const diffs = new Map([['t2', { plus: 2, minus: 1, newFile: false }]]);
        const html = renderToStaticMarkup(<Stream rows={rows} lanes={null} at={null} selectedId={null} onSelect={() => {}} agentName="atlas" diffs={diffs} />);
        expect(html).toContain('data-kind="Bash"');
        expect(html).toContain('data-kind="Edit"');
        // Messages — yours and a peer's — are the chat's, not the Stream's: no speaker labels here at all.
        expect(html).not.toContain('data-who=');
        expect(html).not.toMatch(/>\s*(user|assistant)\s*</);
        // A real diff's numbers as two cells — and only where a diff was computed.
        expect(html).toContain('data-plus="2"');
        expect(html).toContain('data-minus="1"');
        expect((html.match(/data-plus="/g) ?? []).length).toBe(1);
        // A running tool says so, in amber.
        expect(html).toMatch(/data-meta[^>]*>running</);
    });
});

describe('the error card', () => {
    const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn' };
    const broken = { running: false, turnState: 'failed', startedAt: null, pendingApproval: null, failure: { reason: 'ACP stream closed · exit 137', fixes: ['Restart'] }, contextUsed: null, contextSize: null, plan: null } as unknown as LiveSession;
    const render = (session: LiveSession | null) =>
        renderToStaticMarkup(<AgentView agent={agent} session={session} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={3} cost={null} onNavigate={() => {}} onSelect={() => {}} />);

    it('ends the stream when the turn did not finish; absent otherwise', () => {
        const html = render(broken);
        expect(html).toContain('data-stream-error');
        expect(html).toContain('ACP stream closed · exit 137');
        expect(html).toContain('The turn did not finish. The last tool call has no result.');
        expect(render(null)).not.toContain('data-stream-error');
    });
});
