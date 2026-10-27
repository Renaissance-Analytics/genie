import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fullDateTime } from '../src/core/clock-words.js';
import { headroomFromMeta, rateLimitAlert, type Headroom } from '../src/core/headroom.js';
import { HeadroomBoard } from '../src/core/headroom-board.js';
import { toStreamEvent } from '../src/core/stream-event.js';
import { RateLimitDetail, RateLimitPills } from '../src/renderer/components/Dashboard.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { EMPTY_SNAPSHOT } from '../src/renderer/bridge.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * EVERY REPORTED LIMIT ON HOVER, AND A DOT IN THE SIDEBAR (genie#1268; the owner, 2026-10-27: "On hover of the provider
 * rate limit display in the dashboard, I should see all reportable rate limits and my usage. Also, once a rate limit hits
 * 30%, I need an indication in the sidebar menu to draw my eye. It can just be a yellow dot that turns red at 10%.").
 *
 * What the providers report, through prism-acp's `_meta["particle.academy/rate_limit"]`: Claude every window of the
 * frame in `windows` (`five_hour`, `seven_day`, and model windows such as `seven_day_opus`), each a `utilization`
 * FRACTION and its own reset, with the binding `rateLimitType`; Codex `primary` and `secondary`, each `usedPercent`,
 * `windowDurationMins` and its reset, with `planType`. Neither reports an absolute limit, so the hover says % used and %
 * left — never a count made up from them. "Hits 30%" is 30% LEFT: the dot is the warning tone at ≤30% left and the
 * danger tone at ≤10% left, and it is gone once every window is above 30%.
 */
const KEY = 'particle.academy/rate_limit';
const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).getTime();
const claude = {
    status: 'allowed', resetsAtMs: at(27, 16), rateLimitType: 'five_hour',
    windows: { five_hour: { utilization: 0.62, resetsAtMs: at(27, 16) }, seven_day: { utilization: 0.92, resetsAtMs: at(30, 9) }, seven_day_opus: { utilization: 0.4, resetsAtMs: at(31, 9) } },
    raw: {},
};
const codex = { ordinaryUsageAllowed: true, planType: 'pro', primary: { usedPercent: 40, windowDurationMins: 300, resetsAtMs: at(27, 18) }, secondary: { usedPercent: 28, windowDurationMins: 10080, resetsAtMs: at(2, 9) } };

/** A reading whose only window has `leftPct` left. */
const room = (leftPct: number, window = '5h', over = false): Headroom => {
    const w = { window, usedPct: 100 - leftPct, leftPct, resetsAtMs: at(27, 16), over };
    return { plan: null, window, leftPct, resetsAtMs: w.resetsAtMs, over, windows: [w] };
};

describe('every reported window is kept', () => {
    it('Claude: each window of the frame, with its % used, % left and its own reset; the binding one is still the headline', () => {
        const h = headroomFromMeta(claude)!;
        expect(h).toMatchObject({ window: '5h', leftPct: 38 });
        expect(h.windows).toEqual([
            { window: '5h', usedPct: 62, leftPct: 38, resetsAtMs: at(27, 16), over: false },
            { window: '7d', usedPct: 92, leftPct: 8, resetsAtMs: at(30, 9), over: false },
            { window: '7d opus', usedPct: 40, leftPct: 60, resetsAtMs: at(31, 9), over: false },
        ]);
    });

    it('Codex: primary AND secondary, not only the primary', () => {
        const h = headroomFromMeta(codex)!;
        expect(h).toMatchObject({ plan: 'pro', window: '5h', leftPct: 60 });
        expect(h.windows).toEqual([
            { window: '5h', usedPct: 40, leftPct: 60, resetsAtMs: at(27, 18), over: false },
            { window: '7d', usedPct: 28, leftPct: 72, resetsAtMs: at(2, 9), over: false },
        ]);
    });

    it('a window spent past its allowance says so; its used share is the reported one, not clamped', () => {
        const h = headroomFromMeta({ ...claude, windows: { five_hour: { utilization: 1.08, resetsAtMs: at(27, 16) } } })!;
        expect(h.windows).toEqual([{ window: '5h', usedPct: 108, leftPct: 0, resetsAtMs: at(27, 16), over: true }]);
    });

    it('the notice in the ledger carries them too', () => {
        expect(toStreamEvent({ sessionUpdate: 'notice', notice: { level: 'info', message: 'x' }, _meta: { [KEY]: codex } })).toMatchObject({ headroom: { windows: [{ window: '5h' }, { window: '7d' }] } });
    });

    it('the header keeps a window a later reading did not repeat, and takes the newer figure for one it did', () => {
        const board = new HeadroomBoard();
        board.offer('claude', headroomFromMeta(claude)!, 0, 60_000);
        const later = headroomFromMeta({ ...claude, windows: { five_hour: { utilization: 0.7, resetsAtMs: at(27, 16) } } })!;
        expect(board.offer('claude', later, 60_000, 60_000)).toBe(true);
        const shown = board.view()['claude']!;
        expect(shown.leftPct).toBe(30);
        expect(shown.windows.map((w) => [w.window, w.leftPct])).toEqual([['5h', 30], ['7d', 8], ['7d opus', 60]]);
    });
});

describe('the hover on a provider’s pill', () => {
    // Fancy's Tooltip draws its content only on hover, so the card is rendered as the pill hands it over, and the
    // pill's accessible name — the same lines, for a screen reader — is read from the pill itself.
    const card = (provider: string, limit: Headroom) => renderToStaticMarkup(<RateLimitDetail provider={provider} limit={limit} />);
    const named = (html: string, provider: string) => html.match(new RegExp(`data-rate-limit="${provider}"[^>]*aria-label="([^"]*)"`))?.[1] ?? '';

    it('lists every window: % used, % left, and the reset as the full date with am/pm', () => {
        const c = card('claude', headroomFromMeta(claude)!);
        expect(c).toContain(`5h window: 62% used · 38% left · resets ${fullDateTime(at(27, 16))}`);
        expect(c).toContain(`7d window: 92% used · 8% left · resets ${fullDateTime(at(30, 9))}`);
        expect(c).toContain(`7d opus window: 40% used · 60% left · resets ${fullDateTime(at(31, 9))}`);
        expect(fullDateTime(at(30, 9))).toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4} at 9:00 AM$/);
        const x = card('codex', headroomFromMeta(codex)!);
        expect(x).toContain('pro');
        expect(x).toContain(`5h window: 40% used · 60% left · resets ${fullDateTime(at(27, 18))}`);
        expect(x).toContain(`7d window: 28% used · 72% left · resets ${fullDateTime(at(2, 9))}`);
    });

    it('the card is the provider’s logo, not its name (genie#1266)', () => {
        const c = card('claude', headroomFromMeta(claude)!);
        expect(c).toMatch(/data-provider-logo="claude"/);
        expect(c.replace(/<[^>]*>/g, ' ')).not.toMatch(/Claude/);
    });

    it('the pill’s accessible name carries every window too', () => {
        const html = renderToStaticMarkup(<RateLimitPills limits={{ claude: headroomFromMeta(claude)!, codex: headroomFromMeta(codex)! }} />);
        expect(named(html, 'claude')).toContain(`7d window: 92% used · 8% left · resets ${fullDateTime(at(30, 9))}`);
        expect(named(html, 'claude')).toContain('7d opus window: 40% used');
        expect(named(html, 'codex')).toContain(`7d window: 28% used · 72% left · resets ${fullDateTime(at(2, 9))}`);
    });

    it('a spent window reads as over, with the reported share used', () => {
        expect(card('claude', headroomFromMeta({ ...claude, windows: { five_hour: { utilization: 1.08, resetsAtMs: at(27, 16) } } })!)).toContain('5h window: 108% used · over the limit · resets');
    });
});

describe('the sidebar alert', () => {
    it('above 30% left everywhere: none (the edge at 31)', () => {
        expect(rateLimitAlert({ claude: room(31), codex: room(100, '7d') })).toBeNull();
        expect(rateLimitAlert({})).toBeNull();
    });

    it('30% left is the warning; 11% still the warning', () => {
        expect(rateLimitAlert({ claude: room(30) })).toMatchObject({ level: 'warning' });
        expect(rateLimitAlert({ claude: room(11) })).toMatchObject({ level: 'warning' });
    });

    it('10% left is the danger; 0% and over are too', () => {
        expect(rateLimitAlert({ claude: room(10) })).toMatchObject({ level: 'danger' });
        expect(rateLimitAlert({ claude: room(0) })).toMatchObject({ level: 'danger' });
        expect(rateLimitAlert({ claude: room(0, '5h', true) })).toMatchObject({ level: 'danger' });
    });

    it('any window counts, not only the headline one; the worst sets the colour; the label names each low window', () => {
        const a = rateLimitAlert({ claude: headroomFromMeta(claude)!, codex: { ...room(25), plan: 'pro' } })!;
        expect(a.level).toBe('danger');
        expect(a.label).toContain('Claude Code: 8% left this week');
        expect(a.label).toContain('Codex: 25% left in the 5-hour window');
        expect(a.label).not.toContain('opus');
    });

    it('clears once every window is back above 30%', () => {
        const board = new HeadroomBoard();
        board.offer('claude', room(8, '7d'), 0, 60_000);
        expect(rateLimitAlert(board.view())).toMatchObject({ level: 'danger' });
        board.offer('claude', room(95, '7d'), 60_000, 60_000);
        expect(rateLimitAlert(board.view())).toBeNull();
    });
});

describe('the dot on the Dashboard’s sidebar row', () => {
    const sidebar = (alert: Parameters<typeof Sidebar>[0]['rateLimitAlert'], collapsed = false) => renderToStaticMarkup(
        <Sidebar route="genie://settings" deckCount={0} workspaces={[]} available={['deck', 'dashboard', 'settings']} onNavigate={() => {}} railStorage={{ getItem: () => (collapsed ? '1' : '0'), setItem: () => {} }} rateLimitAlert={alert} />,
    );
    const dashboardRow = (html: string) => html.match(/<button[^>]*data-nav="genie:\/\/dashboard"[\s\S]*?<\/button>/)?.[0] ?? '';

    it('yellow at the warning, with its words for a screen reader; static', () => {
        const row = dashboardRow(sidebar({ level: 'warning', label: 'Claude Code: 30% left in the 5-hour window' }));
        expect(row).toMatch(/data-rate-limit-dot="warning"[^>]*role="img"[^>]*aria-label="Claude Code: 30% left in the 5-hour window"/);
        expect(row).toContain('bg-[var(--warning)]');
        expect(row).not.toMatch(/animate-/);
    });

    it('red at the danger', () => {
        const row = dashboardRow(sidebar({ level: 'danger', label: 'Claude Code: 8% left this week' }));
        expect(row).toMatch(/data-rate-limit-dot="danger"/);
        expect(row).toContain('bg-[var(--danger)]');
    });

    it('on the collapsed rail too', () => {
        expect(dashboardRow(sidebar({ level: 'danger', label: 'Claude Code: 8% left this week' }, true))).toMatch(/data-rate-limit-dot="danger"/);
    });

    it('no alert, no dot (positive control above)', () => {
        expect(sidebar(null)).not.toContain('data-rate-limit-dot');
        expect(sidebar(undefined, true)).not.toContain('data-rate-limit-dot');
    });
});

describe('from any page: the Shell lights the dot from the header’s readings', () => {
    const render = (route: string, rateLimits: Record<string, Headroom>) => renderToStaticMarkup(
        <Shell
            route={route}
            snapshot={{ ...EMPTY_SNAPSHOT, workspaces: [], deckItems: [] }}
            features={EMPTY_FEATURES}
            servable={['dashboard', 'deck', 'agent', 'settings', 'knowledge']}
            agentDetail={null}
            agentResolved
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
            rateLimits={rateLimits}
        />,
    );

    it('on Settings, Claude at 8% left this week: the red dot on the Dashboard row, named', () => {
        const html = render('genie://settings', { claude: room(8, '7d') });
        expect(html).toMatch(/data-rate-limit-dot="danger"[^>]*aria-label="Claude Code: 8% left this week"/);
    });

    it('every window above 30%: no dot', () => {
        expect(render('genie://settings', { claude: room(31, '7d') })).not.toContain('data-rate-limit-dot');
    });
});
