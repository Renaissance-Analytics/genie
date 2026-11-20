// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommsMail } from '../src/core/comms.js';
import { agentRecord, type AgentId } from '../src/core/identity.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { withComms } from '../src/main/dashboard-comms.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * THE COMMS COLUMN, FED BY GENIE-HOST (Tynn #956). Since the window's protocol connection rides the engine link to
 * genie-host's RemoteHost (Tynn #898 step 2d-4b, beta.65), this machine's Dashboard rows are genie-host's own registry's
 * (`phoneRegistry`), probed by genie-host's SessionHost. That SessionHost has no `comms` reader, so every row came with
 * `collaborators: null` and no links: the Comms cell rendered EMPTY (the owner read the delivery age beside it, "1m",
 * "8m", "now"), and with no count there was no hover and no flight path.
 *
 * test/comms-arcs-dashboard.test.tsx passed throughout because it hands the Dashboard rows with comms already filled in.
 * This file starts one step earlier, where the regression was: a host probe that carries NO comms, plus the host's
 * mail, through the same `withComms` genie-host's registry uses, `agentRowFor` (what Registry builds rows with), the
 * real Dashboard, a hover, and arcs drawn with real geometry.
 */
const NOW = Date.parse('2026-11-20T10:00:00Z');
const STARTED = NOW - 10 * 60_000;
const NAMES = ['kai', 'atlas', 'wren', 'moth'] as const;
const records = NAMES.map((name) => agentRecord({ id: name as AgentId, workspaceId: 'tynn', provider: 'claude', name }));

/** What genie-host's SessionHost answers: running, and NO comms (it is built without a `comms` reader). */
const hostProbe = (id: AgentId): LiveSession | null => NAMES.includes(id as (typeof NAMES)[number]) ? {
    running: true, turnState: 'working', startedAt: STARTED,
    pendingApproval: null, failure: null, contextUsed: null, contextSize: null,
    lastDelivery: null, collaborators: null, commsAgeSeconds: null, links: null, plan: null, model: null,
} as LiveSession : null;

const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
/** The host inbox: kai and wren just talked (unread), kai asked moth 5 min ago and moth read it, kai wrote the person, and atlas mailed moth before its session. */
const MAIL: CommsMail = [
    { from: 'kai', to: 'wren', sentAt: at(40), readAt: null },
    { from: 'wren', to: 'kai', sentAt: at(20), readAt: at(15) },
    { from: 'kai', to: 'wren', sentAt: at(8), readAt: null },
    { from: 'kai', to: 'moth', sentAt: at(300), readAt: at(290) },
    { from: 'kai', to: 'human', sentAt: at(5), readAt: null },
    { from: 'atlas', to: 'moth', sentAt: at(20 * 60), readAt: null },
];
const mailOf = (id: AgentId): CommsMail => MAIL.filter((m) => m.from === id || m.to === id);

const rowsFrom = (probe: (id: AgentId) => LiveSession | null): AgentRow[] => records.map((r) => agentRowFor(r, probe(r.id), () => NOW));

let host: HTMLDivElement;
let root: Root;
const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
/** happy-dom lays nothing out: the surface at (100, 50), row i at y 100 + 32i, its name ending at x 260. */
function layOut(rows: readonly AgentRow[]): void {
    host.querySelector<HTMLElement>('[data-surface="dashboard"]')!.getBoundingClientRect = rect(100, 50, 1200, 800);
    host.querySelectorAll<HTMLElement>('[data-agent]').forEach((row) => {
        const i = rows.findIndex((r) => r.id === row.dataset.agent);
        row.getBoundingClientRect = rect(100, 100 + i * 32, 1200, 32);
        const name = row.querySelector<HTMLElement>('[data-agent-name]')!;
        name.getBoundingClientRect = rect(160, 100 + i * 32 + 8, 100, 16);
        let col = 0;
        row.querySelectorAll<HTMLElement>('*').forEach((el) => {
            if (el === name || el.childElementCount > 0 || (el.textContent ?? '').trim() === '') return;
            el.getBoundingClientRect = rect(300 + (col % 3) * 74, 100 + i * 32 + 8, 70, 16);
            col += 1;
        });
    });
}
async function render(rows: AgentRow[]): Promise<void> {
    await act(async () => {
        root.render(<Dashboard rows={rows} workspaces={[{ id: 'tynn', path: '/w/tynn' }]} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} />);
    });
    layOut(rows);
}
const cell = (id: string) => host.querySelector<HTMLElement>(`[data-agent="${id}"] [data-comms-cell]`)!;
const hover = (el: Element, x: number, y: number) => act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
});
const arcs = () => [...host.querySelectorAll<SVGGElement>('[data-flight-arc]')];

beforeEach(() => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('CONTROL: the host probe alone (beta.65 as shipped)', () => {
    it('leaves every Comms cell empty, and a hover draws nothing: the regression the owner saw', async () => {
        const rows = rowsFrom(hostProbe);
        expect(rows.map((r) => r.collaborators)).toEqual([null, null, null, null]);
        await render(rows);
        for (const name of NAMES) expect(cell(name).textContent).toBe('');
        hover(cell('kai'), 700, 120);
        expect(host.querySelector('[data-flight-paths]')).toBeNull();
    });
});

describe('genie-host’s Dashboard rows, through withComms', () => {
    it('carry who mailed whom since the session started (agents only, not the person, nothing older)', () => {
        const rows = rowsFrom(withComms(hostProbe, mailOf, () => NOW));
        const kai = rows.find((r) => r.id === 'kai')!;
        expect(kai.collaborators).toBe(2);
        expect(kai.commsAgeSeconds).toBe(8);
        expect(kai.links?.map((l) => [l.peer, l.count])).toEqual([['wren', 3], ['moth', 1]]);
        expect(rows.find((r) => r.id === 'wren')!.collaborators).toBe(1);
        // atlas mailed moth BEFORE its session started: a measured 0, not null.
        expect(rows.find((r) => r.id === 'atlas')!.collaborators).toBe(0);
    });

    it('draw the Comms count, and hovering it draws one visible arc per partner with real geometry', async () => {
        const rows = rowsFrom(withComms(hostProbe, mailOf, () => NOW));
        await render(rows);
        expect(cell('kai').textContent).toContain('2');
        hover(cell('kai'), 700, 120);
        const drawn = arcs();
        expect(drawn.map((a) => a.dataset.peer).sort()).toEqual(['moth', 'wren']);
        for (const arc of drawn) {
            const main = arc.querySelector<SVGPathElement>('path[data-arc-main]')!;
            const d = main.getAttribute('d') ?? '';
            // From the pointer (600, 70 in the surface) to the partner's name: a real cubic, not a point.
            expect(d.startsWith('M600,70 C')).toBe(true);
            const [, end] = d.split(' ').slice(-1)[0]!.split(',').map(Number) as [number, number];
            expect(Number.isFinite(end)).toBe(true);
            expect(Number(main.getAttribute('stroke-width'))).toBeGreaterThan(0);
            expect(Number(arc.getAttribute('opacity'))).toBeGreaterThan(0);
        }
        // The hover highlights the pair: the partners are tinted, the rest dimmed.
        expect(host.querySelector('[data-agent="wren"]')!.getAttribute('data-reveal')).toBe('peer');
        expect(host.querySelector('[data-agent="atlas"]')!.getAttribute('data-reveal')).toBe('dim');
    });

    it('answers a stopped agent as stopped (no probe, no comms), and leaves the host probe’s other fields alone', () => {
        const probe = withComms(hostProbe, mailOf, () => NOW);
        expect(probe('nobody' as AgentId)).toBeNull();
        expect(probe('kai' as AgentId)).toMatchObject({ running: true, turnState: 'working', startedAt: STARTED });
    });

    it('reads the mail as it is now: a new message is counted on the next probe', () => {
        let mail: CommsMail = mailOf('kai' as AgentId);
        const probe = withComms(hostProbe, () => mail, () => NOW);
        expect(probe('kai' as AgentId)?.collaborators).toBe(2);
        expect(probe('kai' as AgentId)?.collaborators).toBe(2);
        mail = [...mail, { from: 'kai', to: 'atlas', sentAt: at(1), readAt: null }];
        expect(probe('kai' as AgentId)?.collaborators).toBe(3);
    });
});

describe('genie-host wires it (the source of this machine’s Dashboard since Tynn #898 2d-4b)', () => {
    it('its registry’s probe adds the comms from its own inbox', () => {
        const src = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8')
            .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(src).toMatch(/phoneRegistry\.setProbe\(withComms\(\(id\) => host\.probe\(id\), \(id\) => own\.inbox\.involving\(id, 2000\)\)\)/);
        expect(src).not.toMatch(/phoneRegistry\.setProbe\(\(id\) => host\.probe\(id\)\)/);
    });
});
