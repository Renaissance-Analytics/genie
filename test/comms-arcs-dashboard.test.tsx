// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * THE COMMS FLIGHT PATHS ON THE BOARD (Tynn #750, option D). The mockup's arcs did not show for the owner, so this file
 * renders the real Dashboard and gives every element REAL coordinates: happy-dom lays nothing out and answers every
 * getBoundingClientRect with zeros, which is exactly what makes lines invisible. Nothing is drawn at rest; hovering a
 * Comms cell draws one path per partner from the pointer to the partner's name; leaving clears them.
 */
const ROW_H = 32;
const rowsData: AgentRow[] = ['kai', 'atlas', 'wren', 'moth'].map((name) => ({
    id: name, name, provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: '3m',
    ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
    collaborators: name === 'kai' ? 2 : name === 'atlas' ? 0 : 1, commsAgeSeconds: name === 'atlas' ? null : 8, contextUsed: null, contextSize: null,
    links: name === 'kai'
        ? [{ peer: 'wren', count: 4, ageSeconds: 8, lastFrom: 'self', unread: true, waiting: false }, { peer: 'moth', count: 1, ageSeconds: 600, lastFrom: 'peer', unread: false, waiting: true }]
        : name === 'atlas' ? [] : [{ peer: 'kai', count: 4, ageSeconds: 8, lastFrom: 'peer', unread: false, waiting: false }],
}) as unknown as AgentRow);

let host: HTMLDivElement;
let root: Root;
let reduced = false;

/** Lay the board out: the surface at (100, 50); row i's name ends at x = 260 and sits at y = 100 + i * 32 + 16. */
function layOut(): void {
    const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const surface = host.querySelector<HTMLElement>('[data-surface="dashboard"]')!;
    surface.getBoundingClientRect = rect(100, 50, 1200, 800);
    host.querySelectorAll<HTMLElement>('[data-agent]').forEach((row) => {
        const i = rowsData.findIndex((r) => r.id === row.dataset.agent);
        row.getBoundingClientRect = rect(100, 100 + i * ROW_H, 1200, ROW_H);
        const name = row.querySelector<HTMLElement>('[data-agent-name]')!;
        name.getBoundingClientRect = rect(160, 100 + i * ROW_H + 8, 100, 16);
        // Every other text leaf in the row: laid out in columns from x 300 to 520, so the right of the board is free.
        let col = 0;
        row.querySelectorAll<HTMLElement>('*').forEach((el) => {
            if (el === name || el.childElementCount > 0 || (el.textContent ?? '').trim() === '') return;
            el.getBoundingClientRect = rect(300 + (col % 3) * 74, 100 + i * ROW_H + 8, 70, 16);
            col += 1;
        });
    });
}
/** The column headers are text too (the first run covered them): stubbed at the top of the table, and a label must keep off them. */
function layOutHeader(): void {
    // The header row is the parent of the windows column's header cell (not an ancestor that merely contains it all).
    const header = host.querySelector<HTMLElement>('[data-column-header="windows"]')?.parentElement;
    expect(header).toBeTruthy();
    expect([...header!.children].filter((el) => el.tagName === 'SPAN').length).toBeGreaterThan(3);
    ([...header!.children] as HTMLElement[]).filter((el) => el.tagName === 'SPAN').forEach((el, k) => {
        el.getBoundingClientRect = () => ({ left: 160 + k * 74, top: 70, width: 70, height: 14, right: 230 + k * 74, bottom: 84, x: 160 + k * 74, y: 70, toJSON: () => ({}) }) as DOMRect;
    });
}
const cell = (id: string) => host.querySelector<HTMLElement>(`[data-agent="${id}"] [data-comms-cell]`)!;
const over = (el: Element, x: number, y: number) => act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y })); el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })); });
const move = (el: Element, x: number, y: number) => act(() => { el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })); });
const out = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
const overlay = () => host.querySelector<SVGSVGElement>('[data-flight-paths]');
const paths = () => [...host.querySelectorAll<SVGPathElement>('[data-flight-arc] path[data-arc-main]')];

beforeEach(async () => {
    reduced = false;
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(<Dashboard rows={rowsData} workspaces={[{ id: 'tynn', path: '/w/tynn' }]} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} />);
    });
    layOut();
    layOutHeader();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('the board at rest', () => {
    it('draws nothing: no overlay, no dashed comm lanes, nothing dimmed', () => {
        expect(overlay()).toBeNull();
        expect(host.querySelector('[data-lane]')).toBeNull();
        expect(host.querySelector('[data-reveal]')).toBeNull();
    });
});

describe('hovering a Comms cell', () => {
    it('draws one real path per partner, starting at the pointer and ending at the partner name', () => {
        over(cell('kai'), 700, 120);
        expect(overlay()).not.toBeNull();
        const drawn = paths();
        expect(drawn).toHaveLength(2);
        for (const p of drawn) {
            const d = p.getAttribute('d') ?? '';
            expect(d.length).toBeGreaterThan(10);
            // Relative to the surface at (100, 50): the pointer is (600, 70).
            expect(d.startsWith('M600,70 C')).toBe(true);
            expect(Number(p.getAttribute('stroke-width'))).toBeGreaterThan(0);
            expect(Number(p.parentElement!.getAttribute('opacity'))).toBeGreaterThan(0);
        }
        // wren is row 2: its name ends at x 260 + 8, mid-height 100 + 64 + 16; relative to the surface: (168, 130). moth row 3: (168, 162).
        const ends = drawn.map((p) => (p.getAttribute('d') ?? '').split(' ').pop());
        expect(ends).toContain('168,130');
        expect(ends).toContain('168,162');
    });

    it('is above the table and never in the way: pointer-events none, a z-index, nothing clipped by an ancestor', () => {
        over(cell('kai'), 700, 120);
        const svg = overlay()!;
        expect(svg.getAttribute('class')).toContain('pointer-events-none');
        expect(svg.getAttribute('class')).toMatch(/z-\d+/);
        expect(svg.getAttribute('class')).toContain('overflow-visible');
        for (let el: Element | null = svg.parentElement; el && el !== document.body; el = el.parentElement) {
            expect(el.getAttribute('class') ?? '').not.toMatch(/overflow-hidden/);
        }
    });

    it('follows the pointer while it moves within the icon', () => {
        const icon = cell('kai');
        over(icon, 700, 120);
        move(icon, 710, 126);
        for (const p of paths()) expect(p.getAttribute('d')!.startsWith('M610,76 C')).toBe(true);
    });

    it('dims the other rows and tints the partners', () => {
        over(cell('kai'), 700, 120);
        expect(host.querySelector('[data-agent="atlas"]')!.getAttribute('data-reveal')).toBe('dim');
        expect(host.querySelector('[data-agent="wren"]')!.getAttribute('data-reveal')).toBe('peer');
    });

    it('amber for the one nobody answered, a pulse for the unread one, dots running the way the last message went', () => {
        over(cell('kai'), 700, 120);
        const arcs = [...host.querySelectorAll<SVGGElement>('[data-flight-arc]')];
        const wren = arcs.find((a) => a.dataset.peer === 'wren')!;
        const moth = arcs.find((a) => a.dataset.peer === 'moth')!;
        expect(wren.dataset.tone).toBe('flow');
        expect(wren.dataset.direction).toBe('out');
        expect(wren.querySelector('[data-arc-pulse]')).not.toBeNull();
        expect(moth.dataset.tone).toBe('waiting');
        expect(moth.dataset.direction).toBe('in');
        expect(moth.querySelector('[data-arc-pulse]')).toBeNull();
        expect(moth.querySelectorAll('[data-arc-dot]').length).toBeGreaterThan(0);
    });

    it('labels name sender and receiver and carry the age', () => {
        over(cell('kai'), 700, 120);
        const text = [...host.querySelectorAll('[data-arc-label]')].map((t) => t.textContent);
        expect(text).toContain('kai › wren 8s');
        expect(text).toContain('moth › kai 10m');
    });

    it('no label covers row text or another label, and every drawn label is on the board', () => {
        over(cell('kai'), 700, 120);
        // Row text in overlay coordinates (the surface is at 100, 50): the name boxes and the stubbed leaves.
        const text: Array<{ x: number; y: number; w: number; h: number }> = [];
        host.querySelectorAll<HTMLElement>('[data-surface="dashboard"] *').forEach((el) => {
            if (el.closest('[data-flight-paths]') || el.childElementCount > 0 || (el.textContent ?? '').trim() === '') return;
            const r = el.getBoundingClientRect();
            if (r.width > 0) text.push({ x: r.left - 100, y: r.top - 50, w: r.width, h: r.height });
        });
        expect(text.length).toBeGreaterThan(8);
        // The header's text is among what the labels avoid (the first Azure run put one over "WORKSPACE").
        expect(text.some((t) => t.y < 50)).toBe(true);
        const labels = [...host.querySelectorAll<SVGTextElement>('[data-arc-label]')].map((t) => ({ x: Number(t.dataset.x), y: Number(t.dataset.y) - 10, w: Number(t.dataset.w), h: Number(t.dataset.h) }));
        expect(labels.length).toBeGreaterThan(0);
        const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        for (const [i, l] of labels.entries()) {
            expect(l.w).toBeGreaterThan(0);
            expect(l.x).toBeGreaterThanOrEqual(0);
            for (const t of text) expect(hit(l, t)).toBe(false);
            for (const other of labels.slice(i + 1)) expect(hit(l, other)).toBe(false);
        }
    });

    it('under prefers-reduced-motion static arrows replace the moving dots', () => {
        reduced = true;
        over(cell('kai'), 700, 120);
        expect(host.querySelector('[data-arc-dot]')).toBeNull();
        expect(host.querySelectorAll('[data-arc-arrow]').length).toBe(2);
    });

    it('with motion allowed there are dots and no static arrows (positive control)', () => {
        over(cell('kai'), 700, 120);
        expect(host.querySelector('[data-arc-dot]')).not.toBeNull();
        expect(host.querySelector('[data-arc-arrow]')).toBeNull();
    });

    it('leaving clears the overlay and the dimming', () => {
        const icon = cell('kai');
        over(icon, 700, 120);
        expect(overlay()).not.toBeNull();
        out(icon);
        expect(overlay()).toBeNull();
        expect(host.querySelector('[data-reveal]')).toBeNull();
    });

    it('an agent with no conversations draws nothing', () => {
        const icon = cell('atlas');
        if (icon) over(icon, 700, 150);
        expect(overlay()).toBeNull();
    });
});
