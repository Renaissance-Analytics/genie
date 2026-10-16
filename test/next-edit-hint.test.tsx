import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE `E next edit` HINT (the board's strip): shown beside the legend when the session has an edit to jump to —
 * `E` is the key (§4.2) — and absent when there is no edit, because a hint about a key that would do nothing is
 * furniture.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const working: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const t = (id: string, event: StreamEvent, at: number): TimedEvent => ({ id, event, at });
const withEdit: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }, 1_000),
    t('a1:1', { kind: 'tool', toolCallId: 'c1', name: 'Edit', title: null, status: 'completed', toolKind: 'edit', rawInput: { file_path: '/w/tynn/a.ts', old_string: 'a', new_string: 'a\nb' } }, 2_000),
];
const noEdit: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }, 1_000),
    t('a1:1', { kind: 'message', speaker: 'agent', peerName: null, text: 'hi' }, 2_000),
];
const render = (rows: TimedEvent[]) =>
    renderToStaticMarkup(<AgentView agent={agent} session={working} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 3_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} />);

describe('the E hint', () => {
    it('is on the strip when the session has an edit to jump to', () => {
        expect(render(withEdit)).toMatch(/data-hint="next-edit"[^>]*>[^<]*E next edit/);
    });

    it('is absent when there is no edit — a key that would do nothing gets no hint', () => {
        const html = render(noEdit);
        expect(html).toContain('data-session-timeline');
        expect(html).not.toContain('data-hint="next-edit"');
    });
});
