import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { flowPills, PILL_LINGER_MS, type EndedFlow, type LiveFlow } from '../src/core/flow-pills.js';
import { FlowPills } from '../src/renderer/components/FlowPills.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { WorkspaceColorsContext } from '../src/renderer/workspace-colors.js';
import { markupText } from './helpers/markup-text.js';

/**
 * RUNNING FLOWS AS PILLS IN THE HEADER (Tynn #707): a pill per running flow (its name, a running light, its workspace's
 * colour), leaving when the run ends - a failed or held one stays briefly - and several collapse to "+N".
 */
const NOW = 1_000_000;
const live = (id: string, ws = 'w1'): LiveFlow => ({ flowId: id, name: `Flow ${id}`, workspaceId: ws, at: new Date(NOW - 1000).toISOString() });
const ended = (id: string, outcome: 'failed' | 'held', ago: number, ws = 'w1'): EndedFlow => ({ flowId: id, name: `Flow ${id}`, workspaceId: ws, outcome, endedAt: new Date(NOW - ago).toISOString() });

describe('flowPills', () => {
    it('a pill for each running flow, in start order', () => {
        const out = flowPills({ live: [live('b'), live('a')], ended: [], now: NOW, workspaceId: null });
        expect(out.shown.map((p) => [p.flowId, p.state])).toEqual([['b', 'running'], ['a', 'running']]);
        expect(out.more).toEqual([]);
    });

    it('a flow that is no longer running has no pill (positive control: running, above)', () => {
        expect(flowPills({ live: [], ended: [], now: NOW, workspaceId: null }).shown).toEqual([]);
    });

    it('a failed or held end shows its state briefly, then goes', () => {
        const fresh = flowPills({ live: [], ended: [ended('x', 'failed', 1000), ended('y', 'held', 1000)], now: NOW, workspaceId: null });
        expect(fresh.shown.map((p) => p.state)).toEqual(['failed', 'held']);
        const stale = flowPills({ live: [], ended: [ended('x', 'failed', PILL_LINGER_MS + 1)], now: NOW, workspaceId: null });
        expect(stale.shown).toEqual([]);
    });

    it('a flow running again is its running pill, not also its old failure', () => {
        const out = flowPills({ live: [live('x')], ended: [ended('x', 'failed', 1000)], now: NOW, workspaceId: null });
        expect(out.shown.map((p) => p.state)).toEqual(['running']);
    });

    it('more than two collapse: two shown, the rest as +N', () => {
        const out = flowPills({ live: [live('a'), live('b'), live('c'), live('d')], ended: [], now: NOW, workspaceId: null });
        expect(out.shown.map((p) => p.flowId)).toEqual(['a', 'b']);
        expect(out.more.map((p) => p.flowId)).toEqual(['c', 'd']);
    });

    it('a workspace-share window sees only that workspace flows', () => {
        const out = flowPills({ live: [live('a', 'w1'), live('b', 'w2')], ended: [ended('c', 'failed', 10, 'w2')], now: NOW, workspaceId: 'w1' });
        expect(out.shown.map((p) => p.flowId)).toEqual(['a']);
    });
});

describe('FlowPills', () => {
    const colors = { workspaces: { w1: '#3b82f6' }, agents: {} };
    const render = (live_: LiveFlow[], ended_: EndedFlow[] = []) => renderToStaticMarkup(
        <WorkspaceColorsContext.Provider value={colors}><FlowPills live={live_} ended={ended_} now={NOW} workspaceId={null} onOpen={() => {}} /></WorkspaceColorsContext.Provider>,
    );

    it('a pill carries the name, a running light and the workspace colour, and is a button', () => {
        const html = render([live('a')]);
        expect(html).toMatch(/<button[^>]*data-flow-pill="a"/);
        expect(html).toContain('Flow a');
        expect(html).toContain('data-flow-state="running"');
        expect(html).toContain('--ws:#3b82f6');
    });

    it('no id of ours is drawn as text', () => {
        const html = render([live('01HZZZZZZZZZZZZZZZZZZZZZZZ')]);
        expect(markupText(html)).not.toContain('01HZZZ');
    });

    it('four runs draw two pills and a +2 that opens a list', () => {
        const html = render([live('a'), live('b'), live('c'), live('d')]);
        expect([...html.matchAll(/data-flow-pill="/g)]).toHaveLength(2);
        expect(html).toContain('data-flow-more="2"');
        expect(html).toContain('+2');
    });

    it('nothing running draws nothing', () => {
        expect(render([])).toBe('');
    });

    it('a failed end says so', () => {
        expect(render([], [ended('x', 'failed', 500)])).toContain('data-flow-state="failed"');
    });
});

describe('the title bar', () => {
    const bar = (extra: object) => renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={null} onNavigate={() => {}} onOpenPalette={() => {}} {...extra} />);
    const flows = { live: [live('a')], ended: [], now: NOW, onOpen: () => {} };

    it('shows the pills when it is given flows', () => {
        expect(bar({ flows })).toContain('data-flow-pill="a"');
    });

    it('the pill sits in a no-drag region, so a click reaches it', () => {
        const html = bar({ flows });
        const at = html.indexOf('data-flow-pills');
        expect(at).toBeGreaterThan(-1);
        expect(html.slice(Math.max(0, at - 400), at + 200)).toContain('-webkit-app-region:no-drag');
    });

    it('a workspace window shows only its own workspace flows', () => {
        const html = bar({ scopedHome: 'genie://workspace/w1', flows: { ...flows, live: [live('a', 'w1'), live('b', 'w2')], workspaceId: 'w1' } });
        expect(html).toContain('data-flow-pill="a"');
        expect(html).not.toContain('data-flow-pill="b"');
    });
});

describe('the title bar lays the pills out beside the address, never over it', () => {
    const bar = (extra: object) => renderToStaticMarkup(<TitleBar route="genie://studio/some/long/route" workstation={null} onNavigate={() => {}} onOpenPalette={() => {}} {...extra} />);
    const flows = { live: [live('a')], ended: [], now: NOW, onOpen: () => {} };
    const tag = (html: string, attr: string): string => html.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>`))![0];

    it('the pills and the address are both direct children of the bar flex row', () => {
        const html = bar({ flows });
        const open = html.indexOf('data-controls-inset');
        expect(tag(html, 'data-controls-inset')).toMatch(/\bflex\b/);
        // Nesting depth below the bar's open tag: equal depth = siblings in the one row.
        const depthAt = (attr: string): number => {
            let depth = 0;
            for (const m of html.slice(open, html.indexOf(attr)).matchAll(/<(\/?)([a-z0-9]+)[^>]*?(\/?)>/g)) {
                if (['svg', 'path', 'circle', 'line', 'rect', 'polyline', 'input', 'img', 'br'].includes(m[2]!) || m[3] === '/') continue;
                depth += m[1] ? -1 : 1;
            }
            return depth;
        };
        expect(depthAt('data-flow-pills')).toBe(depthAt('data-route'));
    });

    it('the pills take their own space: shrink-0 and no absolute positioning', () => {
        const pills = tag(bar({ flows }), 'data-flow-pills');
        expect(pills).toMatch(/\bshrink-0\b/);
        expect(pills).not.toMatch(/\b(absolute|fixed)\b/);
    });

    it('each pill refuses to shrink under its text and stays one line', () => {
        const pill = tag(bar({ flows }), 'data-flow-pill=');
        expect(pill).toMatch(/\bshrink-0\b/);
        expect(pill).not.toMatch(/\b(absolute|fixed)\b/);
    });

    it('the address is the part that gives way: min-w-0 and truncate', () => {
        const route = tag(bar({ flows }), 'data-route');
        expect(route).toMatch(/\bmin-w-0\b/);
        expect(route).toMatch(/\btruncate\b/);
    });

    it('a narrow window collapses to fewer pills and a +N (maxShown)', () => {
        const out = flowPills({ live: [live('a'), live('b'), live('c')], ended: [], now: NOW, workspaceId: null, max: 1 });
        expect(out.shown.map((p) => p.flowId)).toEqual(['a']);
        expect(out.more.map((p) => p.flowId)).toEqual(['b', 'c']);
    });

    it('CONTROL: without a max it is still two', () => {
        const out = flowPills({ live: [live('a'), live('b'), live('c')], ended: [], now: NOW, workspaceId: null });
        expect(out.shown).toHaveLength(2);
    });
});
