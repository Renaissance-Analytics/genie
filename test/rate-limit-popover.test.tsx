// @vitest-environment happy-dom
/**
 * THE RATE-LIMIT PILL OPENS A POPOVER, NOT A TOOLTIP (the owner, 2026-10-31: "can we make these cleaner? this should be a
 * popover not a tooltip."). The old hover was a black tooltip of monospace sentences — "5h window: 60% used · 40% left ·
 * resets Saturday, October 31, 2026 at 3:40 PM" — once per window.
 *
 * Now: the pill is a real button (logo + its most constrained window) that opens react-fancy's Popover on a click and on
 * Enter, and closes on Escape or a click outside. Inside, the provider's logo (genie#1266: the logo, never its name as
 * text), then one row per window — 5h and 7d always, plus any other window the provider reported — each a small bar of
 * the share LEFT coloured like the sidebar dot (warning at ≤30% left, danger at ≤10% or spent), the percentage, and the
 * reset as a short relative time with the exact local time smaller underneath. A window the provider did not report is
 * said to be unknown, with one icon. No monospace, no sentences.
 *
 * Interaction is a claim about a live DOM, so this file renders in happy-dom (docs/decisions.md D4).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shortDateTime } from '../src/core/clock-words.js';
import { headroomFromMeta, limitLevel, resetsIn, type Headroom } from '../src/core/headroom.js';
import { RateLimitPills } from '../src/renderer/components/Dashboard.js';

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const NOW = new Date(2026, 9, 31, 13, 26).getTime();
const MIN = 60_000;
/** Claude, as the owner's screenshot: 5h 60% used (resets in 2h 14m), 7d 35% used (resets in 3d 12h 34m). */
const claude = headroomFromMeta({
    rateLimitType: 'five_hour', resetsAtMs: NOW + 134 * MIN,
    windows: { five_hour: { utilization: 0.6, resetsAtMs: NOW + 134 * MIN }, seven_day: { utilization: 0.35, resetsAtMs: NOW + (3 * 1440 + 12 * 60 + 34) * MIN } },
})!;
/** Codex reported only its 7d window. */
const codexWeekOnly = headroomFromMeta({ primary: { usedPercent: 53, windowDurationMins: 10080, resetsAtMs: NOW + 90 * MIN } })!;

const one = (window: string, leftPct: number, over = false) => ({ window, usedPct: 100 - leftPct, leftPct, resetsAtMs: NOW + 30 * MIN, over });
const reading = (...windows: ReturnType<typeof one>[]): Headroom => ({ plan: null, window: windows[0]!.window, leftPct: windows[0]!.leftPct, resetsAtMs: windows[0]!.resetsAtMs, over: windows[0]!.over, windows });

function render(limits: Record<string, Headroom>): void {
    act(() => root.render(<RateLimitPills limits={limits} now={NOW} />));
}
const pill = (provider: string) => host.querySelector(`[data-rate-limit="${provider}"]`) as HTMLButtonElement;
const popover = (provider: string) => document.querySelector(`[data-rate-limit-popover="${provider}"]`) as HTMLElement | null;
const row = (provider: string, window: string) => popover(provider)?.querySelector(`[data-rate-limit-window="${window}"]`) as HTMLElement | null;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

describe('the pill', () => {
    it('is a real button that says it opens a popover; its logo and its most constrained window', () => {
        // Codex's binding window is its 5h at 60% left; its 7d is tighter at 12% — the pill shows the tighter one.
        const codex = reading(one('5h', 60), one('7d', 12));
        render({ claude, codex });
        const c = pill('claude');
        expect(c.tagName).toBe('BUTTON');
        expect(c.getAttribute('aria-haspopup')).toBe('dialog');
        expect(c.getAttribute('aria-expanded')).toBe('false');
        expect(c.querySelector('[data-provider-logo="claude"]')).not.toBeNull();
        expect(c.textContent).toBe('40%5h');
        expect(pill('codex').textContent).toBe('12%7d');
        expect(pill('codex').getAttribute('data-level')).toBe('warning');
        // A react-fancy Button: the app stylesheet's one base rule gives every enabled one the pointer
        // (test/real-buttons-dashboard.test.tsx), so the pill no longer carries its own cursor class.
        expect(c.hasAttribute('data-react-fancy-button')).toBe(true);
        expect(c.disabled).toBe(false);
        expect(c.className).toMatch(/hover:bg-\[var\(--bg-2\)\]/);
    });

    it('no reading yet: nothing drawn', () => {
        render({});
        expect(host.innerHTML).toBe('');
    });
});

describe('opening and closing', () => {
    it('a click opens the popover; Escape closes it', () => {
        render({ claude });
        expect(popover('claude')).toBeNull();
        click(pill('claude'));
        expect(popover('claude')).not.toBeNull();
        expect(pill('claude').getAttribute('aria-expanded')).toBe('true');
        expect(popover('claude')!.getAttribute('role')).toBe('dialog');
        expect(popover('claude')!.getAttribute('aria-label')).toBe('Claude Code rate limits');
        key(document.body, 'Escape');
        expect(popover('claude')).toBeNull();
    });

    it('Enter on the focused pill opens it (and does not also toggle it shut through the click Enter makes)', () => {
        render({ claude });
        pill('claude').focus();
        key(pill('claude'), 'Enter');
        expect(popover('claude')).not.toBeNull();
        key(pill('claude'), 'Enter');
        expect(popover('claude')).toBeNull();
    });

    it('a click outside closes it; a click inside does not', () => {
        render({ claude });
        click(pill('claude'));
        act(() => { popover('claude')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
        expect(popover('claude')).not.toBeNull();
        act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
        expect(popover('claude')).toBeNull();
    });

    it('it is not a tooltip any more', () => {
        render({ claude });
        click(pill('claude'));
        expect(document.querySelector('[role="tooltip"]')).toBeNull();
    });
});

describe('inside the popover', () => {
    it('the header is the provider’s logo — never its name as text (genie#1266)', () => {
        render({ claude });
        click(pill('claude'));
        expect(popover('claude')!.querySelector('[data-provider-logo="claude"]')).not.toBeNull();
        expect(popover('claude')!.textContent).not.toMatch(/Claude/);
    });

    it('one row per window: a bar of the share left, the percentage, the relative reset and the exact time smaller', () => {
        render({ claude });
        click(pill('claude'));
        const rows = [...popover('claude')!.querySelectorAll('[data-rate-limit-window]')].map((r) => r.getAttribute('data-rate-limit-window'));
        expect(rows).toEqual(['5h', '7d']);

        const five = row('claude', '5h')!;
        const bar = five.querySelector('[role="progressbar"]')!;
        expect(bar.getAttribute('aria-valuenow')).toBe('40');
        expect((bar.querySelector('[data-rate-limit-fill]') as HTMLElement).style.width).toBe('40%');
        expect(five.querySelector('[data-rate-limit-pct]')!.textContent).toBe('40%');
        expect(five.querySelector('[data-rate-limit-reset]')!.textContent).toBe('resets in 2h 14m');
        const exact = five.querySelector('[data-rate-limit-at]')!;
        expect(exact.textContent).toBe(shortDateTime(NOW + 134 * MIN));
        expect(exact.className).toMatch(/text-\[11px\]|text-\[10px\]/);

        const seven = row('claude', '7d')!;
        expect(seven.querySelector('[data-rate-limit-pct]')!.textContent).toBe('65%');
        expect(seven.querySelector('[data-rate-limit-reset]')!.textContent).toBe('resets in 3d 12h');
    });

    it('no monospace and no sentences', () => {
        render({ claude });
        click(pill('claude'));
        const p = popover('claude')!;
        expect(p.outerHTML).not.toMatch(/font-mono/);
        expect(p.textContent).not.toMatch(/window:|used ·|left ·|at \d/);
    });

    it('another window the provider reported gets its own row, after 5h and 7d', () => {
        const h = headroomFromMeta({
            rateLimitType: 'five_hour',
            windows: { five_hour: { utilization: 0.1, resetsAtMs: NOW + MIN }, seven_day: { utilization: 0.2, resetsAtMs: NOW + MIN }, seven_day_opus: { utilization: 0.3, resetsAtMs: NOW + MIN } },
        })!;
        render({ claude: h });
        click(pill('claude'));
        expect([...popover('claude')!.querySelectorAll('[data-rate-limit-window]')].map((r) => r.getAttribute('data-rate-limit-window'))).toEqual(['5h', '7d', '7d opus']);
    });
});

describe('the colour, by the sidebar dot’s rule', () => {
    const levelOf = (leftPct: number, over = false) => {
        render({ claude: reading(one('5h', leftPct, over)) });
        click(pill('claude'));
        const r = row('claude', '5h')!;
        const fill = r.querySelector('[data-rate-limit-fill]')!;
        const out = { level: r.getAttribute('data-level'), fill: fill.className, pill: pill('claude').getAttribute('data-level') };
        key(document.body, 'Escape');
        return out;
    };

    it('31% left: the ordinary tone', () => {
        const o = levelOf(31);
        expect(o.level).toBe('ok');
        expect(o.fill).not.toMatch(/--warning|--danger/);
    });

    it('30% left: the warning (yellow); 11% still the warning', () => {
        expect(levelOf(30)).toMatchObject({ level: 'warning', pill: 'warning' });
        expect(levelOf(30).fill).toContain('bg-[var(--warning)]');
        expect(levelOf(11).level).toBe('warning');
    });

    it('10% left: the danger (red); 0% and spent too', () => {
        expect(levelOf(10)).toMatchObject({ level: 'danger', pill: 'danger' });
        expect(levelOf(10).fill).toContain('bg-[var(--danger)]');
        expect(levelOf(0).level).toBe('danger');
        expect(levelOf(0, true).level).toBe('danger');
    });

    it('the rule itself', () => {
        expect([31, 30, 11, 10, 0].map((leftPct) => limitLevel({ leftPct, over: false }))).toEqual(['ok', 'warning', 'warning', 'danger', 'danger']);
        expect(limitLevel({ leftPct: 50, over: true })).toBe('danger');
    });

    it('a spent window says so instead of a percentage', () => {
        render({ claude: reading(one('5h', 0, true)) });
        expect(pill('claude').textContent).toBe('over5h');
        click(pill('claude'));
        expect(row('claude', '5h')!.querySelector('[data-rate-limit-pct]')!.textContent).toBe('over');
    });
});

describe('a window the provider did not report', () => {
    it('is unknown, said plainly with one icon — no bar, no number, no reset', () => {
        render({ codex: codexWeekOnly });
        click(pill('codex'));
        const five = row('codex', '5h')!;
        expect(five.getAttribute('data-level')).toBe('unknown');
        expect(five.textContent).toBe('5hunknown');
        expect(five.querySelectorAll('[data-react-fancy-icon]').length).toBe(1);
        expect(five.querySelectorAll('[data-provider-logo]').length).toBe(0);
        expect(five.querySelector('[role="progressbar"]')).toBeNull();
        // Positive control: the reported window in the same popover has its bar and number.
        const seven = row('codex', '7d')!;
        expect(seven.querySelector('[role="progressbar"]')).not.toBeNull();
        expect(seven.querySelector('[data-rate-limit-pct]')!.textContent).toBe('47%');
    });
});

describe('the relative reset', () => {
    it('minutes, hours and minutes, days and hours; due now', () => {
        expect(resetsIn(NOW + 14 * MIN, NOW)).toBe('resets in 14m');
        expect(resetsIn(NOW + 134 * MIN, NOW)).toBe('resets in 2h 14m');
        expect(resetsIn(NOW + 120 * MIN, NOW)).toBe('resets in 2h');
        expect(resetsIn(NOW + (3 * 1440 + 12 * 60 + 34) * MIN, NOW)).toBe('resets in 3d 12h');
        expect(resetsIn(NOW + 30_000, NOW)).toBe('resets in <1m');
        expect(resetsIn(NOW - MIN, NOW)).toBe('resets now');
    });

    it('the exact time is short: weekday, date and am/pm time', () => {
        expect(shortDateTime(new Date(2026, 9, 31, 15, 40).getTime())).toBe('Sat, Oct 31, 3:40 PM');
    });
});
