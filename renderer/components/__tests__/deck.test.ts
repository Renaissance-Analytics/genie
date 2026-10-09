import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentSession } from '../../../main/agentsession/model';
import { Deck } from '../Master/Deck';

/**
 * Rendered assertions through `react-dom/server` — the lane `vitest.config.mts`
 * opened for exactly this ("Renderer components ARE tested here now ... since the env
 * has no DOM"), and `React.createElement` rather than JSX because the suite's include
 * globs only collect `*.test.ts`.
 *
 * It matters for this component because its most important behaviours are things it
 * must NOT draw, and an absence is invisible to every other kind of check. Every such
 * assertion here is paired with a POSITIVE CONTROL, because "no $0.00 in the markup"
 * would otherwise also pass for a component that never renders cost at all.
 */

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    agentId: 'a1',
    specId: 's1',
    session: { provider: 'claude', name: 'kai', cwd: '/w', workspaceId: 'w1', sessionId: null },
    turn: { state: 'idle', since: 1_000 },
    thoughts: [],
    liveThought: null,
    rateLimit: null,
    rateLimitUnavailable: null,
    composer: null,
    transcript: [],
    live: null,
    tools: [],
    approvals: [],
    plan: null,
    usage: null,
    commands: null,
    error: null,
    ...over,
});

const NOW = 10_000_000;
const render = (
    sessions: AgentSession[],
    _unused: never[] = [],
    props: Record<string, unknown> = {},
): string => renderToStaticMarkup(React.createElement(Deck, { sessions, now: NOW, ...props }));

/**
 * THE AGENTS BAND IS GONE — and must not come back.
 *
 * The spec board splits the two surfaces by question: the Deck answers "does anything need
 * me?", the Dashboard answers "what is being produced, and by whom?", and the Deck
 * explicitly "gives up its Agents band".
 *
 * beta.1 kept it anyway and made the Deck the default, so two boards listed every agent and
 * the Deck's copy was the inert one — bare divs with no handler on the screen Genie opened
 * on. The duplication was the design error; the unreachability was what made it visible.
 *
 * Asserted as an ABSENCE with a positive control, because "no roster in the markup" would
 * otherwise also pass against a Deck that renders nothing at all.
 */
describe('the Deck gives up its Agents band', () => {
    it('POSITIVE CONTROL: it still renders, and still resolves what needs you', () => {
        const html = render([session()], [], {
            questions: [
                {
                    id: 'q1',
                    index: 0,
                    questions: [
                        {
                            header: 'Migrate the pulse ring, or dual-write?',
                            question: 'Which way for one release?',
                            options: [{ label: 'Dual-write for one release' }, { label: 'Migrate now' }],
                        },
                    ],
                    createdAt: NOW - 60_000,
                },
            ],
        });
        expect(html).toContain('Migrate the pulse ring');
    });

    it('does not draw a roster of agents', () => {
        // The agent IS on the board -- it simply is not this board's subject. A Deck that
        // names it here is the duplication returning.
        const html = render([session()]);
        expect(html).not.toContain('kai');
        // `deck-row` is the roster line's own class. NOT `deck-band` — that is the shared
        // band shell and `NeedsYou` still uses it, so asserting on it would have been a
        // test of the wrong subject that happened to be red.
        expect(html).not.toContain('deck-row');
    });

    it('draws no agent heading, totals or fidelity label', () => {
        const html = render([
            session(),
            session({ agentId: 'a2', session: { ...session().session, name: 'vale' } }),
        ]);
        expect(html).not.toContain('Agents');
        expect(html).not.toContain('terminal only');
        expect(html).not.toMatch(/\d+ live/);
    });
});


describe('the workstation SIGNALS, now that the icons are going', () => {
    /**
     * Owner decision, asked directly: *"move the signals to the Deck, then delete the icons."*
     *
     * P7's "8 icons → 0 icons, 0 features lost" held for features — every one has a ⌘K row with a
     * CI guard — and not for SIGNALS: the icons animated for a running Flow, badged unread agent
     * mail, warned about GitHub permissions. A palette row cannot do any of that.
     *
     * `stationSignals` decides WHICH and in what order, and is tested without a DOM. These cases
     * are the part a pure function cannot cover: that they are on the Deck, and that silence is
     * silence.
     */
    const facts = {
        flowsRunning: false,
        mailBehind: 0,
        githubBlocked: false,
        osWorking: false,
        issueWatchUnknown: false,
    };

    it('renders NOTHING when nothing is happening', () => {
        // Not a row of green ticks. A strip of reassurances is furniture, and furniture trains
        // people to stop reading the one line that will matter.
        const html = render([], [], { signals: facts });
        expect(html).not.toContain('deck-signals');
    });

    it('shows a running Flow', () => {
        const html = render([], [], { signals: { ...facts, flowsRunning: true } });
        expect(html).toContain('deck-signals');
        expect(html).toContain('A Flow is running');
    });

    it('shows mail agents have not picked up, with the count', () => {
        expect(render([], [], { signals: { ...facts, mailBehind: 3 } })).toContain(
            '3 messages waiting for agents',
        );
    });

    it('marks the TONE, so blocked does not read like busy', () => {
        const html = render([], [], {
            signals: { ...facts, githubBlocked: true, flowsRunning: true },
        });
        expect(html).toContain('data-tone="attention"');
        expect(html).toContain('data-tone="busy"');
    });

    it('is still a DOOR — each signal names the feature it is about', () => {
        // The icons were a signal AND a way in. A badge you cannot act on is worse than an icon
        // you can.
        expect(render([], [], { signals: { ...facts, githubBlocked: true } })).toContain(
            'data-feature="github-caps"',
        );
    });

    it('renders nothing at all when the host did not report any facts', () => {
        // A window that cannot see the workstation (a remote one) must not claim all is well.
        expect(render([])).not.toContain('deck-signals');
    });
});
