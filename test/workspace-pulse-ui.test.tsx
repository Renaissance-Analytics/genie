import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { RailItem } from '../src/core/rail-view.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';

/**
 * THE ROW THAT PULSES INSTEAD (genie#1265): the workspace an agent acted in — opened a file, changed a tab, opened a site —
 * pulses in the rail, and in the Dashboard when it is open, until the person goes there. Genie 1's attention glow on the
 * workspace row (v0.7.0-beta.342 renderer/components/Master/Chooser.tsx `wsAttention`, styles/master.css
 * `.chooser-flyout .tproj.attention > .tproj-head` → `attention-row-glow 1.6s ease-in-out infinite`), here driven by
 * agent actions. Reduced motion: the same ring, still (Tailwind `motion-safe:` animates only when motion is allowed).
 */

const item = (over: Partial<RailItem>): RailItem => ({ id: 'tynn', path: '/w/tynn', name: 'tynn', count: 2, alert: false, working: 0, ...over } as RailItem);
const memory = (collapsed: boolean): Pick<Storage, 'getItem' | 'setItem'> => {
    const data = new Map([['genie.rail.collapsed', collapsed ? '1' : '0']]);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const rail = (pulsing: ReadonlySet<string> | undefined, collapsed = false) => renderToStaticMarkup(
    <Sidebar route="genie://dashboard" deckCount={0} workspaces={[item({}), item({ id: 'fancy', name: 'fancy', path: '/w/fancy' })]} available={['deck', 'dashboard', 'workspace']} onNavigate={() => {}} railStorage={memory(collapsed)} {...(pulsing ? { pulsing } : {})} />,
);
const button = (html: string, id: string) => html.match(new RegExp(`<button[^>]*data-workspace="${id}"[^>]*>`))?.[0] ?? '';

describe('the rail', () => {
    it('the pulsing workspace’s row pulses (motion-safe) with a still ring for reduced motion; the others do not', () => {
        const html = rail(new Set(['tynn']));
        expect(button(html, 'tynn')).toMatch(/data-workspace-pulse="true"/);
        expect(button(html, 'tynn')).toMatch(/motion-safe:animate-pulse/);
        expect(button(html, 'tynn')).toMatch(/ring-1/);
        // Never a bare animate-pulse: that would ignore prefers-reduced-motion.
        expect(button(html, 'tynn')).not.toMatch(/(^|[\s"])animate-pulse/);
        expect(button(html, 'fancy')).not.toMatch(/data-workspace-pulse/);
        expect(html.match(/data-workspace-pulse="true"/g) ?? []).toHaveLength(1);
    });

    it('the collapsed rail pulses the same workspace’s icon', () => {
        const html = rail(new Set(['tynn']), true);
        expect(button(html, 'tynn')).toMatch(/data-workspace-pulse="true"[^>]*motion-safe:animate-pulse|motion-safe:animate-pulse[^>]*data-workspace-pulse="true"/);
        expect(button(html, 'fancy')).not.toMatch(/data-workspace-pulse/);
    });

    it('once cleared (the person went there), nothing pulses', () => {
        expect(rail(new Set())).not.toMatch(/data-workspace-pulse/);
        expect(rail(undefined)).not.toMatch(/data-workspace-pulse/);
    });
});

const agent: AgentRow = {
    id: 'a1', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle',
    duration: '1m', ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
};
const board = (pulsing: ReadonlySet<string> | undefined) => renderToStaticMarkup(
    <Dashboard rows={[agent, { ...agent, id: 'b1', name: 'pica', workspaceId: 'fancy' }]} workspaces={[{ id: 'tynn', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }]} onOpenAgent={() => {}} onAddAgent={() => {}} {...(pulsing ? { pulsing } : {})} />,
);
const header = (html: string, id: string) => html.match(new RegExp(`<div[^>]*data-workspace-head="${id}"[^>]*>`))?.[0] ?? '';

describe('the Dashboard', () => {
    it('the pulsing workspace’s group header pulses (motion-safe, still ring otherwise); the others do not', () => {
        const html = board(new Set(['fancy']));
        expect(header(html, 'fancy')).toMatch(/data-workspace-pulse="true"/);
        expect(header(html, 'fancy')).toMatch(/motion-safe:animate-pulse/);
        expect(header(html, 'tynn')).not.toBe('');
        expect(header(html, 'tynn')).not.toMatch(/data-workspace-pulse/);
    });

    it('nothing pulses once cleared', () => {
        expect(board(new Set())).not.toMatch(/data-workspace-pulse/);
    });
});
