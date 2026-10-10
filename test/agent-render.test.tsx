import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentView } from '../src/renderer/components/AgentView.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE AGENT VIEW, RENDERED.
 *
 * ## The one test in this repository that is about §0.4 directly
 *
 * The Conversation UI was BUILT, SHIPPED and UNREACHABLE for three releases.
 * `sessionFidelity()` returned `observed` for every agent, so every agent rendered
 * `Activity | Files | Changes`, and a finished feature was hidden behind one condition. Every
 * test of that feature was green, because every one of them rendered the feature directly
 * instead of asking whether the screen would.
 *
 * So the first assertion below renders the whole surface for a declared agent and insists the
 * Stream is **present and showing**, with an observed agent in the same file as the contrast.
 */

const at = 1_760_000_000_000;

const timed = (event: StreamEvent, id: string): TimedEvent => ({ id, event, at });

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'working', startedAt: at - 14_000,
    pendingAsk: null, failure: null, contextUsed: null, contextSize: null,
    lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null,
    ...over,
});

const AGENT = { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared' as const, cwd: 'repos/genie2' };

const ROWS: readonly TimedEvent[] = [
    timed({ kind: 'message', speaker: 'you', peerName: null, text: 'Add the passkey endpoint' }, 'm1'),
    timed(
        {
            kind: 'tool', toolCallId: 't1', name: 'Edit', title: 'src/core/session.ts',
            status: 'completed', toolKind: 'edit',
            rawInput: { file_path: 'src/core/session.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
        },
        'ed1',
    ),
];

function render(over: Partial<Parameters<typeof AgentView>[0]> = {}): string {
    return renderToStaticMarkup(
        <AgentView
            agent={AGENT}
            session={session()}
            rows={ROWS}
            tab="stream"
            lanes={null}
            at={null}
            selectedId={null}
            turns={11}
            cost={null}
            onNavigate={() => {}}
            onSelect={() => {}}
            now={() => at}
            {...over}
        />,
    );
}

describe('a declared agent gets the Stream, and it is SHOWING', () => {
    it('renders the Stream tab, selected, with rows in it', () => {
        const html = render();

        expect(html).toContain('data-tab="stream"');
        expect(html).toMatch(/data-tab="stream"[^>]*data-active="true"/);
        expect(html).toContain('data-stream="rows"');
        expect(html).toContain('data-stream-row="m1"');
    });

    it('shows the Stream with an EMPTY STATE rather than hiding it when there are no events', () => {
        // Never gated on anything beyond fidelity. With no events it says so; it does not hide.
        const html = render({ rows: [] });

        expect(html).toContain('data-tab="stream"');
        expect(html).toContain('data-stream="empty"');
        expect(html).toContain('Nothing yet');
    });

    it('gives an OBSERVED agent no Stream tab at all — absence, not a disabled tab', () => {
        const html = render({
            agent: { ...AGENT, fidelity: 'observed' },
            tab: 'stream',
        });

        expect(html).not.toContain('data-tab="stream"');
        expect(html).toContain('data-tab="terminal"');
        expect(html).not.toContain('disabled');
        // Asked for a tab it does not have, it falls back to its first rather than rendering an
        // empty body under a strip that does not contain the selected tab.
        expect(html).toMatch(/data-tab="terminal"[^>]*data-active="true"/);
    });

    it('counts which fidelities render a Stream, rather than spot-checking the one that should', () => {
        // The §0.4 shape, as a count. A boolean on `declared` passes while `observed` also
        // renders one, or while NEITHER does.
        const fidelities = ['declared', 'observed', 'remote'] as const;
        const withStream = fidelities.filter((f) =>
            render({ agent: { ...AGENT, fidelity: f } }).includes('data-tab="stream"'),
        );
        expect(withStream).toEqual(['declared']);

        // POSITIVE CONTROL: all three render a tab strip, so the filter above is reading
        // something rather than three empty surfaces.
        const withTabs = fidelities.filter((f) =>
            render({ agent: { ...AGENT, fidelity: f } }).includes('role="tablist"'),
        );
        expect(withTabs).toEqual([...fidelities]);
    });
});

describe('the header', () => {
    it('names the agent, its provider and its working directory, with a state pill', () => {
        const html = render();

        expect(html).toContain('kai');
        expect(html).toContain('claude');
        expect(html).toContain('repos/genie2');
        expect(html).toContain('data-pill="thinking"');
        expect(html).toContain('0:14');
    });

    it('shows NO clock on an idle agent', () => {
        // An elapsed timer on an idle agent counts up forever and reads as work in progress.
        const html = render({ session: session({ running: false, turnState: 'idle' }) });

        expect(html).toContain('data-pill="idle"');
        expect(html).not.toContain('0:14');
    });

    it('reads the parked question as the state', () => {
        const html = render({ session: session({ turnState: 'idle', pendingAsk: 'Allow migrate --force?' }) });
        expect(html).toContain('data-pill="waiting on you"');
    });
});

describe('the right rail', () => {
    it('is ABSENT rather than empty before the first turn', () => {
        /**
         * *"The persona file and provider headroom are known before the first turn, so they
         * show. Plan and context are not known yet, so they are absent, not empty."*
         *
         * An empty Plan panel reads as an agent working with no plan.
         */
        const html = render({ session: null });

        expect(html).not.toContain('data-rail="plan"');
        expect(html).not.toContain('data-rail="budget"');

        // POSITIVE CONTROL: with a plan and a context figure, both appear.
        const full = render({
            session: session({ plan: { step: 3, of: 7, doing: 'Passkey enrolment endpoint' }, contextUsed: 38_000, contextSize: 200_000 }),
        });
        expect(full).toContain('data-rail="plan"');
        expect(full).toContain('data-rail="budget"');
        expect(full).toContain('3/7');
    });

    it('omits the COST ROW when the provider reports none, and keeps the turn count', () => {
        // codex reports no cost. Not a `$0.00`, which claims the work was free.
        const html = render({ session: session({ contextUsed: 38_000, contextSize: 200_000 }), cost: null });

        expect(html).toContain('data-rail="budget"');
        expect(html).not.toContain('data-rail-cost');
        expect(html).not.toContain('$');
        expect(html).toContain('11 turns');

        // POSITIVE CONTROL: a provider that DOES report one gets the row.
        const priced = render({ session: session({ contextUsed: 38_000, contextSize: 200_000 }), cost: 0.91 });
        expect(priced).toContain('data-rail-cost');
        expect(priced).toContain('$0.91');
    });
});

describe('the Inspector', () => {
    it('is closed on arrival', () => {
        expect(render()).not.toContain('data-inspector');
    });

    it('opens as a diff when an edit row is selected', () => {
        const html = render({ selectedId: 'ed1' });

        expect(html).toContain('data-inspector="diff"');
        expect(html).toContain('src/core/session.ts');
    });

    it('does not open for a row that is not a tool call', () => {
        // A message has nothing to inspect. Selecting one must not open a panel that then says
        // nothing — which reads as a broken inspector rather than as the wrong selection.
        expect(render({ selectedId: 'm1' })).not.toContain('data-inspector');
    });

    it('does not open for an id that is not in the stream', () => {
        // A stale `?at=` from a pruned row. Absence, not an empty panel.
        expect(render({ selectedId: 'gone' })).not.toContain('data-inspector');
    });

    it('states a REASON rather than opening empty when the arguments were not reported', () => {
        const rows: readonly TimedEvent[] = [
            timed(
                {
                    kind: 'tool', toolCallId: 't9', name: 'Edit', title: 'x.ts',
                    status: 'completed', toolKind: 'edit', rawInput: null,
                },
                'blind',
            ),
        ];
        const html = render({ rows, selectedId: 'blind' });

        expect(html).toContain('data-inspector="none"');
        expect(html).toContain('did not report');
    });
});
