import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * FIND IN THE AGENT VIEW: the box sits at the right of the chips row (`Find in stream  /`); a query narrows the
 * Stream to the rows that say it, counts the matches, and when nothing matches the Stream says which nothing it is.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const working: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }),
    // Activity the query can find (a message would be in the chat, not the Stream).
    t('a1:1', { kind: 'tool', toolCallId: 'c1', name: 'Bash', title: 'php artisan test', status: 'completed', toolKind: 'execute', rawInput: null }),
    t('a1:2', { kind: 'think', text: 'looking for the suite', tokens: null }),
    t('a1:3', { kind: 'message', speaker: 'agent', peerName: null, text: 'Six passed.' }),
];
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={working} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

describe('find in stream', () => {
    it('the box is in the chips row, empty, with no count', () => {
        const html = render();
        expect(html).toMatch(/data-chips[\s\S]*?<input[^>]*data-find=""/);
        expect(html).not.toContain('data-find-count');
    });

    it('a query narrows the Stream to the rows that say it, keeps the turn marker, and counts the matches', () => {
        const html = render({ find: 'artisan' });
        expect(html).toMatch(/data-find=""[^>]*value="artisan"/);
        expect(html).toContain('data-find-count="1"');
        expect(html).toContain('data-stream-row="a1:1"');
        expect(html).toContain('data-stream-row="a1:0"');
        expect(html).not.toContain('data-stream-row="a1:2"');
        expect(html).not.toContain('data-stream-row="a1:3"');
    });

    it('nothing matches → the Stream says so, naming the query, not "no events yet"', () => {
        const html = render({ find: 'zebra' });
        expect(html).toContain('data-find-count="0"');
        expect(html).toContain('data-stream="empty"');
        expect(html).toContain('Nothing says “zebra”');
        expect(html).not.toContain('No events yet');
    });
});
