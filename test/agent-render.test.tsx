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
    pendingApproval: null, failure: null, contextUsed: null, contextSize: null,
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
        const html = render({ session: session({ turnState: 'idle', pendingApproval: { question: 'Allow migrate --force?', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] } }) });
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

describe('found by looking at the running Agent view', () => {
    it('does not draw the rail AT ALL when it has nothing to put in it', () => {
        /**
         * *"A section that can never populate is not drawn for that agent — absence of the
         * rail, not an empty rail."*
         *
         * The screenshot showed a 260px column with a left border and nothing inside it. An
         * empty bordered panel reads as one that failed to load, and it costs a fifth of the
         * width of the screen that matters most.
         */
        const html = render({ session: null });

        expect(html).not.toContain('data-rail-column');
        expect(html).not.toContain('data-rail=');

        // POSITIVE CONTROL: with a plan it IS drawn, so the absence is a reading.
        const withPlan = render({
            session: session({ plan: { step: 3, of: 7, doing: 'Passkey enrolment endpoint' } }),
        });
        expect(withPlan).toContain('data-rail-column');
        expect(withPlan).toContain('data-rail="plan"');
    });

    it('draws the rail for a budget alone, not only for a plan', () => {
        // Either panel is enough. Requiring both would hide a context warning on an agent that
        // never reported a plan, which is most of them.
        const html = render({ session: session({ contextUsed: 38_000, contextSize: 200_000 }) });
        expect(html).toContain('data-rail-column');
        expect(html).toContain('data-rail="budget"');
    });

    it('offers a way to TALK to the agent', () => {
        /**
         * The screenshot had no composer and no route to one. The chat flyout is the only place
         * a human types to an agent — it replaces the Agent view's composer — so without a
         * control that opens it, this screen is read-only and a person can open an agent and
         * then do nothing with it.
         *
         * P3's bar is *"a real day's work done through the Stream"*. A screen you cannot type
         * into does not clear it.
         */
        const html = render();

        expect(html).toContain('data-action="chat"');
        // It navigates to the route that opens the flyout on THIS agent, so the conversation
        // is linkable and a pinned chat's subject is in the URL rather than in a component.
        expect(html).toContain('chat=kai');
    });
});

const APPROVAL = {
    question: 'php artisan migrate --force',
    options: [
        { id: 'allow', label: 'Allow', tone: 'ok' as const },
        { id: 'deny', label: 'Deny', tone: 'bad' as const },
        { id: 'mystery', label: 'Allow once and remember', tone: 'neutral' as const },
    ],
};

describe('a parked approval renders in exactly ONE place', () => {
    const parked = () => session({ pendingApproval: APPROVAL });

    it('is ACTIONABLE in the stream when no chat is open on this agent', () => {
        const html = render({ session: parked(), chatSubject: null });

        expect(html).toContain('data-approval');
        expect(html).toContain('data-approval-option="allow"');
        expect(html).toContain('data-approval-option="deny"');
        expect(html).toContain('php artisan migrate --force');
        // And no marker, because this IS the actionable copy.
        expect(html).not.toContain('data-approval-marker');
    });

    it('becomes a MARKER when the chat is open on this agent', () => {
        /**
         * *"The approval renders wherever the composer is."* The chat flyout is the only place
         * a human types to an agent, so an open chat takes the approval with it.
         *
         * Two live sets of buttons for one decision is not cosmetic: answering in one leaves
         * the other showing a resolved question, and the reader cannot tell whether their
         * answer landed.
         */
        const html = render({ session: parked(), chatSubject: 'kai' });

        expect(html).toContain('data-approval-marker');
        expect(html).not.toContain('data-approval-option');
        // The marker still says a decision is parked and where to make it. Showing nothing
        // would leave somebody reading a stream that has silently stopped.
        expect(html).toContain('waiting on a decision');
    });

    it('is NEVER both at once \u2014 counted across every chat subject', () => {
        // A boolean on one case passes while another renders both. Count the surfaces that
        // carry live buttons; it may only ever be one or none.
        const subjects = [null, 'kai', 'wren', 'genie'];
        const doubles = subjects.filter((subject) => {
            const html = render({ session: parked(), chatSubject: subject });
            return html.includes('data-approval-option') && html.includes('data-approval-marker');
        });

        expect(doubles).toEqual([]);

        // POSITIVE CONTROL: each subject renders ONE of them, so the absence is a reading.
        const neither = subjects.filter((subject) => {
            const html = render({ session: parked(), chatSubject: subject });
            return !html.includes('data-approval-option') && !html.includes('data-approval-marker');
        });
        expect(neither).toEqual([]);
    });

    it('renders nothing at all when there is no approval', () => {
        const html = render({ session: session(), chatSubject: null });
        expect(html).not.toContain('data-approval');
    });

    it('does not colour an option whose kind the protocol did not name', () => {
        /**
         * `neutral` reaches the DOM as an uncoloured button. A provider could ship an option
         * called "Allow once and remember" that denies, or one in another language — and a
         * substring match on "allow" would paint a deny button green, which is the single most
         * dangerous way this surface could be wrong.
         */
        const html = render({ session: parked(), chatSubject: null });

        expect(html).toMatch(/data-approval-option="mystery"[^>]*data-tone="neutral"/);
        expect(html).toMatch(/data-approval-option="allow"[^>]*data-tone="ok"/);
        expect(html).toMatch(/data-approval-option="deny"[^>]*data-tone="bad"/);
    });

    it('stops accepting presses while an answer is in flight', () => {
        // The provider is blocked on a SINGLE promise. A second answer resolves nothing, and
        // the second press would look ignored.
        const html = render({ session: parked(), chatSubject: null, answeringApproval: 'allow' });
        expect(html).toMatch(/data-approval-option="deny"[^>]*disabled=""/);

        // POSITIVE CONTROL: not disabled when nothing is in flight.
        //
        // It earned its keep immediately. The first version of this matched `[^>]*disabled`,
        // which also matches the Tailwind class `disabled:opacity-50` sitting in the same tag —
        // so the "not disabled" assertion failed, and the "is disabled" one would have passed
        // on a button that was never disabled at all. The attribute is asserted with its `=""`.
        const idle = render({ session: parked(), chatSubject: null });
        expect(idle).not.toMatch(/data-approval-option="deny"[^>]*disabled=""/);
    });

    it('reads the agent as WAITING in the header pill', () => {
        // The same fact, through the other reader. A row that is waiting and a pill that says
        // thinking is the kind of disagreement that makes people stop trusting both.
        expect(render({ session: parked() })).toContain('data-pill="waiting on you"');
    });
});
