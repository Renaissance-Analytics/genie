import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import type { AgentRow } from '../src/core/dashboard-view.js';

/**
 * THE DASHBOARD AS MARKUP.
 *
 * ## What this can and cannot prove — stated first, because the last build got this wrong
 *
 * It renders the real component with `react-dom/server` and asserts the string. That is a
 * claim about MARKUP: which cells exist, which are absent, the grid template, the row
 * heights, the order rows come out in. **It is not a claim that the surface looks right, fits
 * a 900px screen, or that clicking a row opens anything.** Those belong to the smoke path on
 * a VM — and four releases shipped on green suites exactly because somebody read a passing
 * render as a working window.
 *
 * No browser, no Electron, no jsdom. The house rule is absolute: nothing GUI runs on the
 * owner's desktop, and `renderToStaticMarkup` needs none of it.
 *
 * ## Every absence claim here carries a positive control
 *
 * "The context cell is absent" passes identically on a build that renders no context cell
 * ever. So each absence is asserted against a render that ALSO contains the present case —
 * usually the same render, two rows — and the assertions are COUNTS, because a spot-check on
 * one row passes while another row still leaks a zero.
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

const WORKSPACES = [{ id: 'tynn', path: 'C:/_Projects/tynn.ai' }, { id: 'fancy', path: 'C:/_Projects/fancy' }];

function render(rows: readonly AgentRow[], workspaces = WORKSPACES): string {
    return renderToStaticMarkup(
        <Dashboard rows={rows} workspaces={workspaces} onOpenAgent={() => {}} onAddAgent={() => {}} />,
    );
}

/** The markup of one agent row, sliced out so an assertion cannot accidentally read a sibling's. */
function rowHtml(html: string, id: string): string {
    const start = html.indexOf(`data-agent="${id}"`);
    expect(start, `row ${id} is in the markup`).toBeGreaterThan(-1);
    const next = html.indexOf('data-agent="', start + 20);
    return html.slice(start, next === -1 ? undefined : next);
}

describe('the grid is the board\u2019s, exactly', () => {
    it('uses one column template for the header and for every agent row', () => {
        // The template is a single constant on purpose. Transcribing it twice is how a header
        // and its body drift by a few pixels and nobody can say when it started.
        const html = render([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
        const template = 'grid-cols-[150px_minmax(190px,1.15fr)_minmax(0,1.1fr)_minmax(0,1.45fr)_60px_84px]';

        // 3 agent rows + 1 column header. COUNT, not "contains" — one row rendering a
        // different template would pass a `toContain`.
        expect(html.split(template).length - 1).toBe(4);
    });

    it('holds the stated row heights: 56px view header, 28px header rows, 32px body rows', () => {
        // Two agents in `tynn`, and `fancy` left empty, so the arithmetic is worth writing
        // out — the first draft of this test guessed it and failed, which was the fixture
        // being wrong rather than the component. The board's heights are:
        //   view header 56 (h-14) · column header 28 (h-7) · group header 28 (h-7)
        //   agent row 32 (h-8)   · empty-workspace row 32 (h-8)
        const html = render([row({ id: 'a' }), row({ id: 'b' })]);

        expect(html.split(' h-14 ').length - 1).toBe(1);  // the view header, once
        expect(html.split(' h-8 ').length - 1).toBe(3);   // 2 agents + `fancy`'s "No agents"
        expect(html.split(' h-7 ').length - 1).toBe(3);   // 1 column header + 2 group headers

        // And no row anywhere is left to the browser's own line-height. A height that is
        // merely "about right" is what turns a 20-agent budget into 14 on someone's machine.
        expect(html).not.toMatch(/class="[^"]*row[^"]*"(?![^>]*h-)/);
    });
});

describe('the sort order reaches the DOM', () => {
    it('emits waiting \u2192 broken \u2192 working \u2192 idle \u2192 remote in document order', () => {
        // The view-model is tested for this separately. This asserts the component does not
        // re-order, re-group or stably-sort it back to insertion order on the way out.
        const html = render([
            row({ id: 'idle-one', state: 'idle' }),
            row({ id: 'remote-one', state: 'remote', fidelity: 'remote' }),
            row({ id: 'working-one', state: 'working' }),
            row({ id: 'broken-one', state: 'broken', fixes: ['Sign in to kimi'] }),
            row({ id: 'waiting-one', state: 'waiting', ask: 'Allow migrate --force?' }),
        ]);

        const order = [...html.matchAll(/data-agent="([^"]+)"/g)].map((m) => m[1]);
        expect(order).toEqual(['waiting-one', 'broken-one', 'working-one', 'idle-one', 'remote-one']);
    });
});

describe('a cell Genie cannot see is ABSENT, and the control proves the cell exists at all', () => {
    it('renders the context cell at 182k and nothing at 38k', () => {
        const html = render([
            row({ id: 'hot', contextUsed: 182_000 }),
            row({ id: 'cool', contextUsed: 38_000 }),
        ]);

        // PRESENT — the positive control. Without it, "cool has no context" passes on a build
        // that never renders context for anybody.
        expect(rowHtml(html, 'hot')).toContain('182k');
        expect(rowHtml(html, 'hot')).toContain('data-context-bar="bad"');

        // ABSENT — and absent means no bar and no label, not a dash and not a zero.
        expect(rowHtml(html, 'cool')).not.toContain('data-context-bar');
        expect(rowHtml(html, 'cool')).not.toMatch(/\d+k</);
    });

    it('renders no comms cell when the count could not be attributed, beside one that could', () => {
        const html = render([
            row({ id: 'known', collaborators: 4, commsAgeSeconds: 8 }),
            row({ id: 'unknown', collaborators: null }),
        ]);

        // PRESENT: the count, and the ActivityLight for a live edge.
        expect(rowHtml(html, 'known')).toContain('>4</span>');
        expect(rowHtml(html, 'known')).toContain('data-react-fancy-activity-light="live"');

        // ABSENT: no light, and above all no `0`.
        expect(rowHtml(html, 'unknown')).not.toContain('data-react-fancy-activity-light');
        expect(rowHtml(html, 'unknown')).not.toMatch(/>0</);
    });

    it('keeps the count and drops the LIGHT when the edge\u2019s recency is unobservable', () => {
        // The subtle one, and the reason `ActivityLight` takes `level: null` at all. A grey dot
        // would assert "quiet", which is a claim about a thing we did not see.
        const html = render([row({ id: 'undatable', collaborators: 4, commsAgeSeconds: null })]);
        const cell = rowHtml(html, 'undatable');

        expect(cell).toContain('>4</span>');
        expect(cell).not.toContain('data-react-fancy-activity-light');
    });

    it('gives an OBSERVED agent no comms cell, no context cell, and the word Active', () => {
        const html = render([
            row({ id: 'declared', state: 'working', contextUsed: 182_000 }),
            row({
                id: 'observed', fidelity: 'observed', state: 'working', target: null,
                activity: [3, 6, 4, 9], collaborators: 3, contextUsed: 190_000,
            }),
        ]);
        const observed = rowHtml(html, 'observed');

        expect(observed).toContain('Active');
        expect(observed).not.toContain('Working');
        // Activity bars instead of a target: a measurement where the other is a claim.
        expect(observed).toContain('data-activity="bars"');

        // Both cells absent even though the fixture HANDS IT numbers — a stale value from
        // elsewhere must not be able to present itself as a live reading.
        expect(observed).not.toContain('data-react-fancy-activity-light');
        expect(observed).not.toContain('data-context-bar');
        expect(observed).not.toContain('190k');

        // POSITIVE CONTROL in the same render: the declared row has both.
        expect(rowHtml(html, 'declared')).toContain('data-react-fancy-activity-light');
        expect(rowHtml(html, 'declared')).toContain('data-context-bar');
    });

    it('renders no zero ANYWHERE for an agent that has reported nothing', () => {
        // Not a spot-check: scan the whole row for a standalone zero in any cell. The failure
        // this guards against is a cell nobody thought about — a cost, a count, a diff stat —
        // quietly defaulting to 0 and reading as a measurement.
        const bare = render([row({
            id: 'fresh', state: 'idle', duration: null, step: null, target: null,
            collaborators: null, contextUsed: null, delivery: null,
        })]);

        expect([...rowHtml(bare, 'fresh').matchAll(/>\s*0\s*</g)]).toEqual([]);
        expect(rowHtml(bare, 'fresh')).not.toContain('\u2014');  // and no em-dash, which reads as zero

        // POSITIVE CONTROL: a measured zero IS rendered. `collaborators: 0` is the agent
        // telling us it works alone, which is a fact, and suppressing it would be
        // indistinguishable from never having looked.
        const measured = render([row({ id: 'alone', collaborators: 0, commsAgeSeconds: null })]);
        expect(rowHtml(measured, 'alone')).toMatch(/>0</);
    });
});

describe('the Dashboard resolves nothing', () => {
    it('carries no approve, deny or answer control \u2014 while still carrying fix buttons', () => {
        const html = render([
            row({ id: 'waiting-one', state: 'waiting', ask: 'Allow php artisan migrate --force?' }),
            row({ id: 'broken-one', state: 'broken', reason: 'Provider sign-in expired', fixes: ['Sign in to kimi'] }),
        ]);

        // The question is SHOWN, as the status detail. It is answered on the Deck.
        expect(rowHtml(html, 'waiting-one')).toContain('Allow php artisan migrate --force?');
        expect(rowHtml(html, 'waiting-one')).not.toContain('<button');

        // POSITIVE CONTROL: the surface does render buttons, so "no approve button" is not
        // passing on a build that renders no buttons at all. A broken row's fix route is not a
        // resolution — it repairs the agent, it does not answer for the human.
        expect(rowHtml(html, 'broken-one')).toContain('data-fix="Sign in to kimi"');
        expect(html).not.toMatch(/>(Approve|Deny|Allow|Answer)</);
    });
});

describe('workspaces', () => {
    it('offers Add agent on an empty workspace rather than leaving a blank', () => {
        const html = render([row({ id: 'a', workspaceId: 'tynn' })]);

        expect(html).toContain('data-add-agent="fancy"');
        expect(html).toContain('No agents');
        // The populated one does not get the offer.
        expect(html).not.toContain('data-add-agent="tynn"');
    });

    it('shows the workspace path and a summary that never says zero', () => {
        const html = render([
            row({ id: 'a', workspaceId: 'tynn' }),
            row({ id: 'b', workspaceId: 'tynn', state: 'waiting', ask: 'ok?' }),
        ]);

        expect(html).toContain('C:/_Projects/tynn.ai');
        expect(html).toContain('2 agents · 1 waiting');
        expect(html).not.toContain('0 broken');
    });

    it('renders twenty agents without collapsing any into a \u201c+n more\u201d', () => {
        // The density budget, asserted on the markup: a census that hides members is not a
        // census, so the count of rendered rows must equal the count handed in.
        const rows = Array.from({ length: 20 }, (_, i) =>
            row({ id: `a${i}`, workspaceId: i % 2 === 0 ? 'tynn' : 'fancy' }));
        const html = render(rows);

        expect([...html.matchAll(/data-agent="/g)]).toHaveLength(20);
        expect(html).not.toMatch(/\+\d+ more/);
    });
});

describe('header chips', () => {
    it('emits a chip per populated state and none for an empty one', () => {
        const html = render([
            row({ id: '1', state: 'waiting', ask: 'ok?' }),
            row({ id: '2', state: 'working' }),
            row({ id: '3', state: 'working' }),
        ]);

        expect(html).toContain('data-chip="waiting"');
        expect(html).toContain('1 waiting on you');
        expect(html).toContain('2 working');
        expect(html).not.toContain('data-chip="broken"');
    });
});
