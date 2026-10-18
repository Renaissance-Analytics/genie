import { CHAT_DOCK_DEFAULT_WIDTH } from '../src/core/dock.js';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { CHAT_STRIP_WIDTH, DOCK_WIDTH } from '../src/core/dock.js';
import type { ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE WHOLE SURFACE AT ONCE — chrome, rail and Dashboard in one render.
 *
 * ## Why this file exists separately from the component tests
 *
 * Because the component tests pass with the pieces wired to nothing. §0.4 is a Conversation UI
 * that was BUILT, shipped, and unreachable: one condition hid a finished feature, and every
 * test of that feature was green. The composed render is the cheapest thing that would have
 * caught it — not proof the app works, but proof the parts are connected to each other.
 *
 * It still only reads markup. It does not prove the window opens, the layout holds at any
 * width, or that a click navigates; §8.1's smoke path on a VM owns those.
 */

function row(over: Partial<AgentRow> = {}): AgentRow {
    return {
        id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn',
        fidelity: 'declared', state: 'working', duration: '12m',
        ask: null, reason: null, fixes: [], step: '4/7', target: 'Passkey enrolment endpoint',
        activity: null, delivery: null, collaborators: 4, commsAgeSeconds: 8,
        contextUsed: null, contextSize: 200_000,
        ...over,
    };
}

const LIVE: GenieSnapshot = {
    agents: [
        row({ id: 'kai', name: 'kai', state: 'waiting', ask: 'Allow php artisan migrate --force?' }),
        row({ id: 'wren', name: 'wren', workspaceId: 'fancy', contextUsed: 182_000 }),
    ],
    workspaces: [
        { id: 'tynn', path: 'C:/_Projects/tynn.ai', agentsKnown: true },
        { id: 'fancy', path: 'C:/_Projects/fancy', agentsKnown: true },
    ],
    // One real item, because the rail's badge count is DERIVED from the band now rather than
    // carried beside it. A fixture with an empty band and a badge of 1 could not exist, which
    // is the point: two numbers for one fact is how a badge ends up saying 3 while the Deck
    // shows 2, and the badge is the thing people trust enough not to check.
    deckItems: [{
        id: 'approval:kai', source: 'agent-question', agentId: 'kai', agentName: 'kai',
        workspaceId: 'tynn', title: 'Allow php artisan migrate --force?', blocking: true,
        priority: 'normal', at: 1_760_000_000_000,
        answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] },
        forwardedFrom: null,
    }],
    signals: { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
    workstation: { name: 'alphar', healthy: true },
};

function render(over: Partial<Parameters<typeof Shell>[0]> = {}): string {
    return renderToStaticMarkup(
        <Shell
            route="genie://dashboard?group=workspace"
            snapshot={LIVE}
            servable={['dashboard', 'deck', 'agent', 'workspace']}
            agentDetail={null}
            agentResolved={false}
            selectedRowId={null}
            chatThread={null}
            pinned={null}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            onSend={() => {}}
            onCloseChat={() => {}}
            answeringApproval={null}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
            {...over}
        />,
    );
}

describe('the default route lands on a populated Dashboard', () => {
    it('renders the bar, the rail and real agent rows together', () => {
        const html = render();

        expect(html).toContain('data-surface="dashboard"');
        expect(html).toContain('data-agent="kai"');
        expect(html).toContain('data-agent="wren"');

        // The chrome is there and it is reading from the same snapshot.
        expect(html).toContain('alphar');
        expect(html).toContain('data-deck-badge="1"');
        expect(html).toContain('data-workspace="tynn"');
    });

    it('needs no keyboard shortcut to reach \u2014 the Dashboard IS the default route', () => {
        /**
         * The owner's acceptance bar: a person with no instructions reaches the Dashboard and
         * opens an agent inside thirty seconds, and **if that needs a shortcut it fails.**
         *
         * What a markup test can honestly assert is the two halves of that: the default route
         * already renders the board, and the way to an agent is a clickable row rather than a
         * key. Whether a human manages it in thirty seconds is a question for a person on a VM.
         */
        const html = render({ route: 'genie://dashboard?group=workspace' });

        expect(html).toContain('data-surface="dashboard"');
        // A row a pointer can hit, and a labelled route home in the bar.
        expect(html).toMatch(/data-agent="kai"[^>]*role="row"|role="row"[^>]*data-agent="kai"/);
        expect(html).toContain('data-nav="genie://dashboard"');
    });

    it('shows the route in the bar and the matching surface in the body', () => {
        // One copy of "where am I". The failure this guards is a rail highlighting one surface
        // while the body shows another, which is unfixable once two places track it.
        const html = render({ route: 'genie://dashboard?group=status' });

        expect(html).toContain('genie://dashboard?group=status');
        expect(html).toMatch(/data-nav="genie:\/\/dashboard"[^>]*data-active="true"/);
    });
});

describe('a surface this build cannot serve', () => {
    it('renders an empty body rather than a frame pretending to be a surface', () => {
        // `App` redirects it; the Shell's job is to not invent a screen. Asserted because the
        // alternative — a header over nothing — reads as a load that failed.
        const html = render({ route: 'genie://deck', servable: ['dashboard'] });

        expect(html).not.toContain('data-surface="dashboard"');
        expect(html).not.toContain('data-agent=');
        // POSITIVE CONTROL: the chrome is still rendered, so this is not an empty document.
        expect(html).toContain('data-route');
        expect(html).toContain('alphar');
    });
});

describe('first paint, before the bridge has answered', () => {
    it('claims NOTHING \u2014 no agents, no zeros, no fault light', () => {
        /**
         * The single most dangerous render in the application, because it is the one that
         * happens before any data exists and the one nobody looks at twice.
         *
         * *"No agents"* and *"we have not heard yet"* are different claims. The empty snapshot
         * must make the second one, which means **no counts, no zero badge, and no workstation
         * dot** — a red dot here would assert the machine is unwell before anything checked.
         */
        const html = renderToStaticMarkup(
            <Shell
                route="genie://dashboard?group=workspace"
                snapshot={EMPTY_SNAPSHOT}
                servable={['dashboard']}
                agentDetail={null}
                agentResolved={false}
                selectedRowId={null}
                chatThread={null}
                pinned={null}
                onNavigate={() => {}}
                onOpenAgent={() => {}}
                onAddAgent={() => {}}
                onAddWorkspace={() => {}}
                onOpenPalette={() => {}}
                onSelectRow={() => {}}
                onSend={() => {}}
                onCloseChat={() => {}}
                answeringApproval={null}
                onAnswerApproval={() => {}}
                onAnswerDeckItem={() => {}}
            />,
        );

        expect(html).not.toContain('data-agent=');
        expect(html).not.toContain('data-deck-badge');
        expect(html).not.toContain('data-workstation-health');
        expect([...html.matchAll(/>\s*0\s*</g)]).toEqual([]);

        // And it renders a SKELETON, not the first-run invitation. *"First paint is skeletons,
        // never zeros and never an empty state."* The invitation says "we looked and there is
        // nothing here", which before the bridge answers is a claim about somebody's machine
        // that nobody has checked. This assertion caught exactly that regression once already.
        expect(html).toContain('data-dashboard="loading"');
        expect(html).not.toContain('data-dashboard="first-run"');
        expect(html).not.toContain('Nothing is being worked on yet');

        // POSITIVE CONTROL: it is a real window, not a blank one — the chrome is there, so the
        // test is not passing on an empty render.
        expect(html).toContain('data-route');
        expect(html).toContain('Dashboard');

        // And the SAME component with a real snapshot does show all three, which is what makes
        // the absences above mean something.
        // Full availability, because the Deck badge needs the Deck row to live in.
        const live = render();
        expect(live).toContain('data-agent="kai"');
        expect(live).toContain('data-deck-badge="1"');
        expect(live).toContain('data-workstation-health="healthy"');
    });
});

describe('twenty agents on one board', () => {
    it('renders all twenty through the shell, not just through the table', () => {
        // The density budget, asserted on the composed surface. Twenty at 32px fit a 900px
        // screen; what a markup test can prove is that none of them is dropped on the way.
        const agents = Array.from({ length: 20 }, (_, i) =>
            row({ id: `a${i}`, name: `agent-${i}`, workspaceId: i % 2 === 0 ? 'tynn' : 'fancy' }));

        const html = render({ snapshot: { ...LIVE, agents } });

        expect([...html.matchAll(/data-agent="/g)]).toHaveLength(20);
        expect(html).not.toMatch(/\+\d+ more/);
        // Both workspace groups rendered, and the rail agrees on the counts.
        expect(html).toMatch(/data-workspace="tynn"[\s\S]*?>10</);
    });
});

const DETAIL: AgentDetail = {
    agent: { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared', cwd: 'repos/genie2' },
    session: {
        running: true, turnState: 'working', startedAt: null, pendingApproval: null, failure: null,
        contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null,
        commsAgeSeconds: null, plan: null, model: null,
    },
    rows: [{ id: 'r1', event: { kind: 'message', speaker: 'you', peerName: null, text: 'go' }, at: null }],
    turns: 3,
    cost: null,
    refusal: null,
};

describe('the agent route', () => {
    it('renders the Agent view for the agent the route names', () => {
        const html = render({ route: 'genie://agent/kai?tab=stream', agentDetail: DETAIL, agentResolved: true });

        expect(html).toContain('data-surface="agent"');
        expect(html).toContain('data-agent="kai"');
        expect(html).toContain('data-tab="stream"');
        // The chrome is still there and still shows where you are.
        expect(html).toContain('genie://agent/kai?tab=stream');
    });

    it('distinguishes NOT ASKED YET from NO SUCH AGENT', () => {
        /**
         * `agentDetail === null` is both states, and they must not share a rendering. Showing
         * the not-found while the detail loads would flash an error on **every** navigation to
         * a perfectly good agent — and once someone has seen that twice they stop trusting it
         * when it is real.
         */
        const loading = render({ route: 'genie://agent/kai', agentDetail: null, agentResolved: false });
        expect(loading).not.toContain('data-surface="agent-unknown"');
        expect(loading).not.toContain('No agent is registered');

        const missing = render({ route: 'genie://agent/ghost', agentDetail: null, agentResolved: true });
        expect(missing).toContain('data-surface="agent-unknown"');
        expect(missing).toContain('ghost');
        // And it offers the way back, rather than being a dead end.
        expect(missing).toContain('Back to the Dashboard');
    });

    it('does not render the Dashboard underneath the Agent view', () => {
        // One surface at a time. Two surfaces in one body is how a rail ends up disagreeing
        // with what is on screen.
        const html = render({ route: 'genie://agent/kai', agentDetail: DETAIL, agentResolved: true });
        expect(html).not.toContain('data-surface="dashboard"');
    });

    it('offers the genie rail row only because the AGENT surface is servable', () => {
        /**
         * The rail's rows are derived from `servable`, so the OS agent's row cannot exist
         * without the surface it navigates to. One source of truth: two lists drift, and the
         * failure is silent both ways.
         */
        const withAgent = render({ servable: ['dashboard', 'agent'] });
        expect(withAgent).toContain('data-nav="genie://agent/genie"');

        const without = render({ servable: ['dashboard'] });
        expect(without).not.toContain('data-nav="genie://agent/genie"');
    });
});

const THREAD: ChatThread = {
    agentId: 'kai', name: 'kai', fidelity: 'declared', unread: null, messages: [],
};

describe('the dock geometry \u2014 three shipped failures live here', () => {
    it('an open chat is never overlaid: it is in the dock, positioned in the row, not absolute (2026-10-17)', () => {
        const html = render({ route: 'genie://dashboard?chat=kai', chatThread: THREAD, pinned: null });
        expect(html).not.toContain('data-chat="overlay"');
        expect(html).not.toMatch(/data-chat="pinned"[^>]*class="[^"]*absolute/);
        // CONTROL: closed, the strip's reserve.
        expect(render({ route: 'genie://dashboard?group=workspace' })).toContain(`data-dock-reserve="${CHAT_STRIP_WIDTH}"`);
    });

    it('reserves exactly the chat’s width when open, from the SAME number the panel is sized by', () => {
        /**
         * One number. **Two numbers is a panel overlapping the content by their difference** —
         * which shipped twice, and the second time it was a three-pixel overlap nobody could
         * name.
         *
         * Asserted as an identity against `DOCK_WIDTH` rather than against `380`, because what
         * must hold is that the reserve and the panel cannot diverge. The literal 380 is pinned
         * separately in `dock.test.ts`.
         */
        const html = render({
            route: 'genie://dashboard?chat=kai', chatThread: THREAD,
        });

        // The pinned CHAT's width is its own (Tynn #798, default CHAT_DOCK_DEFAULT_WIDTH): reserve and panel, one number.
        expect(html).toContain(`data-dock-reserve="${CHAT_DOCK_DEFAULT_WIDTH}"`);
        expect(html).toContain('data-chat="pinned"');
        expect(html).toContain(`width:${CHAT_DOCK_DEFAULT_WIDTH}px`);
        // The reserve is a variable the surface's body reads (styles.css), not a margin on the whole row.
        expect(html).toContain(`--dock-reserve:${CHAT_DOCK_DEFAULT_WIDTH}px`);
        expect(html).not.toContain(`margin-right:${CHAT_DOCK_DEFAULT_WIDTH}px`);
    });

    it('starts the gutter BELOW THE VIEW HEADER \u2014 the surface\u2019s own header keeps its width', () => {
        /**
         * §4.4: a pinned panel "reserves a 380px gutter that starts *below* the view header. The header keeps its
         * width and position; the table reflows". The view header is the SURFACE's (the Dashboard's 56px row), not
         * the title bar — a reserve on the whole content row narrowed that header too. Now the row carries the
         * reserve as a variable, styles.css applies it to everything in a surface except its marked header, and
         * the docked panel's frame starts at the header's measured height (56px until measured).
         */
        const html = render({
            route: 'genie://dashboard?chat=kai', chatThread: THREAD,
        });

        expect(html.match(/data-view-header/g)).toHaveLength(1);
        expect(html).toMatch(/data-surface="dashboard"[^>]*><div data-view-header/);
        expect(html).toMatch(/data-dock-frame="chat"[^>]*style="[^"]*top:var\(--view-header-h\)/);
        expect(html).toContain('--view-header-h:56px');
        const css = readFileSync('src/renderer/styles.css', 'utf8');
        expect(css).toMatch(/\[data-surface\]\s*>\s*:not\(\[data-view-header\]\)\s*\{\s*margin-right:\s*var\(--dock-reserve,\s*0px\)/);
    });

    it('every surface marks its own header once, as its first child (positive control: the Dashboard above)', () => {
        for (const [route, over] of [
            ['genie://deck', {}],
            ['genie://workspace/tynn', {}],
            ['genie://agent/kai', { agentDetail: DETAIL, agentResolved: true }],
        ] as const) {
            const html = render({ route, ...over });
            expect(html.match(/data-view-header/g), route).toHaveLength(1);
            expect(html, route).toMatch(/data-surface="[a-z]+"[^>]*><(div|header) data-view-header/);
        }
    });

    it('a pinned file panel: its reserve while the chat is closed; the chat’s own once it opens (one slot, one number)', () => {
        expect(render({ route: 'genie://dashboard', pinned: 'files' })).toContain(`data-dock-reserve="${DOCK_WIDTH}"`);
        expect(render({ route: 'genie://dashboard?chat=kai', chatThread: THREAD, pinned: 'files' })).toContain(`data-dock-reserve="${CHAT_DOCK_DEFAULT_WIDTH}"`);
    });

    it('the open chat has a close button and no pin (there is nothing to unpin it to)', () => {
        const html = render({ route: 'genie://dashboard?chat=kai', chatThread: THREAD });
        expect(html).toContain('aria-label="Close chat"');
        expect(html).not.toContain('data-chat-pin');
    });

    it('shows no chat at all when the route names none', () => {
        const html = render({ route: 'genie://dashboard?group=workspace' });
        expect(html).not.toContain('data-chat=');
        expect(html).toContain(`data-dock-reserve="${CHAT_STRIP_WIDTH}"`);
    });
});

describe('the chat thread', () => {
    it('renders NO greeting and no system line \u2014 an empty thread says nothing', () => {
        /**
         * Every fake greeting is a message the agent did not send, attributed to it, in the one
         * place a person reads what it said.
         */
        const html = render({ route: 'genie://dashboard?chat=kai', chatThread: THREAD, pinned: null });

        expect(html).not.toContain('data-chat-message');
        expect(html).not.toMatch(/How can I help|Hello|Hi there/i);
        // POSITIVE CONTROL: the panel IS rendered, so this is not an absent component.
        expect(html).toContain('data-chat="pinned"');
    });

    it('marks an UNDELIVERED message rather than dropping it or pretending it sent', () => {
        // Dropping it loses what somebody wrote; showing it as sent is worse — they would wait
        // for an answer that cannot come.
        const html = render({
            route: 'genie://dashboard?chat=kai',
            chatThread: { ...THREAD, messages: [{ id: 'm1', from: 'you', text: 'ping', delivered: false }] },
            pinned: null,
        });

        expect(html).toContain('data-chat-undelivered="m1"');
        // The board's words: "Not delivered. <agent> is not running." — with the route to send it.
        expect(html).toContain('Not delivered. kai is not running.');
    });

    it('gives an OBSERVED agent a different SHAPE of chat, not a disabled one', () => {
        /**
         * It is a TUI the user opened via Take Over. Genie can put a message in its AgentInbox
         * and cannot see what it says back, so the composer is labelled for the inbox and the
         * head chip reads `observed - mail only`. **Replies are not shown**, because that TUI
         * does not report them — an empty transcript there would read as an agent ignoring you.
         */
        const html = render({
            route: 'genie://dashboard?chat=kora',
            chatThread: { ...THREAD, agentId: 'kora', name: 'kora', fidelity: 'observed' },
            pinned: null,
        });

        expect(html).toContain('data-chat-chip="mail-only"');
        expect(html).toContain('send to kora');
        expect(html).toContain('inbox');

        // POSITIVE CONTROL: a declared agent gets neither the chip nor that placeholder.
        const declared = render({ route: 'genie://dashboard?chat=kai', chatThread: THREAD, pinned: null });
        expect(declared).not.toContain('data-chat-chip="mail-only"');
        expect(declared).toContain('Message kai');
    });

    it('shows NO unread badge when the count could not be read', () => {
        // `null`, never `0`. A zero claims you are up to date, which is a different statement
        // from "we could not read the count".
        const unknown = render({ route: 'genie://dashboard?chat=kai', chatThread: THREAD, pinned: null });
        expect(unknown).not.toContain('data-chat-unread');

        // POSITIVE CONTROL: a real count renders.
        const three = render({
            route: 'genie://dashboard?chat=kai', chatThread: { ...THREAD, unread: 3 }, pinned: null,
        });
        expect(three).toContain('data-chat-unread="3"');

        // And a measured zero renders nothing either: there is genuinely nothing to announce.
        // Which is the one place in this codebase where `0` and `null` DO render alike, and it
        // is deliberate — a badge is a call to action, not a readout.
        const zero = render({
            route: 'genie://dashboard?chat=kai', chatThread: { ...THREAD, unread: 0 }, pinned: null,
        });
        expect(zero).not.toContain('data-chat-unread');
    });
});

describe('the Deck surface', () => {
    it('renders at its route, with the band on it', () => {
        const html = render({ route: 'genie://deck' });

        expect(html).toContain('data-surface="deck"');
        expect(html).toContain('data-deck-item="approval:kai"');
        expect(html).toContain('data-approval-option="allow"');
    });

    it('offers the Deck row in the rail, because the surface can now be served', () => {
        // The rail's rows are DERIVED from `servable`, so this is not a separate decision —
        // it is the same one, read from the other end.
        expect(render()).toContain('data-nav="genie://deck"');
    });

    it('badges the rail from the BAND, so the two cannot disagree', () => {
        /**
         * One number, one source. Two copies is how a badge ends up saying 3 while the Deck
         * shows 2 — and the badge is the one people trust enough not to check.
         */
        expect(render()).toContain('data-deck-badge="1"');

        const empty = render({ snapshot: { ...LIVE, deckItems: [] } });
        expect(empty).not.toContain('data-deck-badge');

        // POSITIVE CONTROL: the surface still renders; it is the BADGE that is absent.
        expect(empty).toContain('data-nav="genie://deck"');
    });

    it('shows no badge while the queue is unread — which is not the same as empty', () => {
        const unread = render({ snapshot: { ...LIVE, deckItems: null } });
        expect(unread).not.toContain('data-deck-badge');
    });

    it('does not render the Dashboard underneath the Deck', () => {
        const html = render({ route: 'genie://deck' });
        expect(html).not.toContain('data-surface="dashboard"');
    });
});

describe('onboarding in the shell', () => {
    it('a MEASURED empty estate (workspaces []) shows the two steps on the Dashboard; a populated one shows nothing of it', () => {
        const empty = render({ snapshot: { ...LIVE, agents: [], workspaces: [], deckItems: [] } });
        expect(empty).toContain('data-onboarding');
        expect(empty).toMatch(/data-step="pick-folder"[^>]*data-active="true"/);
        expect(render()).not.toContain('data-onboarding');
    });

    it('before the bridge has answered (workspaces null) there is NO onboarding — a skeleton is not an invitation', () => {
        expect(render({ snapshot: EMPTY_SNAPSHOT })).not.toContain('data-onboarding');
    });
});
