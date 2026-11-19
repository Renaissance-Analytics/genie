// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * THE ROW TRAY'S `Terminal →` (Tynn #857). The owner (2026-11-18): the expanded Dashboard row's Terminal → only went to the
 * workspace's home page. It must open a real SHELL in that agent's workspace, in a window of its own: the path the agents
 * sidebar button and the row's Open window → Terminal take since #851 (`onOpenTerminalWindow` → `scratchTerminal`).
 * It never navigates and never opens the agent (its TUI); a terminal that did not open says why, on the button.
 *
 * Interaction is a claim about a live DOM, so the clicks run in happy-dom through the real Dashboard.
 */

const row = (over: Partial<AgentRow>): AgentRow => ({
    id: 'x', name: 'x', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null, ask: null,
    reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null,
    commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
});
const ROWS: AgentRow[] = [
    row({ id: 'a_tynn', name: 'tynn-one', workspaceId: 'tynn' }),
    row({ id: 'a_fancy', name: 'fancy-one', workspaceId: 'fancy', state: 'working' }),
];
type Opened = { ok: true } | { ok: false; reason: string };

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

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const click = (el: Element | null | undefined) => {
    if (!el) throw new Error('no element to click');
    act(() => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

let shells: string[];
let navigations: string[];
let opened: string[];
const mount = (opts: { trayId?: string; open?: ((workspaceId: string) => Promise<Opened>) | null } = {}) => {
    shells = []; navigations = []; opened = [];
    const open = opts.open === undefined ? async (workspaceId: string): Promise<Opened> => { shells.push(workspaceId); return { ok: true }; } : opts.open;
    act(() => root.render(
        <Dashboard
            rows={ROWS} workspaces={[{ id: 'tynn', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }]}
            onOpenAgent={(id) => { opened.push(id); }} onAddAgent={() => {}} onAddWorkspace={() => {}}
            trayId={opts.trayId ?? 'a_fancy'} onNavigate={(route) => { navigations.push(route); }}
            {...(open ? { onOpenTerminalWindow: open } : {})}
        />,
    ));
};
const door = (name: string) => host.querySelector<HTMLButtonElement>(`[data-row-tray] [data-door="${name}"]`);

describe('the expanded row’s Terminal → (Tynn #857)', () => {
    it('opens a SHELL in that agent’s workspace — it never navigates to the workspace home, never opens the agent', async () => {
        mount();
        click(door('terminal'));
        await flush();
        expect(shells).toEqual(['fancy']);
        expect(navigations, 'went to a page instead of opening a terminal').toEqual([]);
        expect(opened, 'opened the agent (its TUI)').toEqual([]);
    });

    it('the shell is in THE TRAY ROW’s workspace, not another row’s', async () => {
        mount({ trayId: 'a_tynn' });
        click(door('terminal'));
        await flush();
        expect(shells).toEqual(['tynn']);
    });

    it('a terminal that did not open says why, on the button; the next try clears it', async () => {
        let answer: Opened = { ok: false, reason: 'the workspace folder is gone' };
        mount({ open: async (workspaceId) => { shells.push(workspaceId); return answer; } });
        click(door('terminal'));
        await flush();
        const failed = door('terminal')!;
        expect(failed.hasAttribute('data-terminal-failed')).toBe(true);
        expect(failed.getAttribute('title')).toContain('the workspace folder is gone');
        expect(navigations).toEqual([]);
        answer = { ok: true };
        click(door('terminal'));
        await flush();
        expect(door('terminal')!.hasAttribute('data-terminal-failed')).toBe(false);
        expect(shells).toEqual(['fancy', 'fancy']);
    });

    it('an opener that throws says why, on the button', async () => {
        mount({ open: async () => { throw new Error('Terminals are not ready yet.'); } });
        click(door('terminal'));
        await flush();
        expect(door('terminal')!.getAttribute('title')).toContain('Terminals are not ready yet.');
    });

    it('a window that cannot open a shell has the door disabled — it does not fall back to the workspace page', async () => {
        mount({ open: null });
        expect(door('terminal')!.disabled).toBe(true);
        click(door('terminal'));
        await flush();
        expect(navigations).toEqual([]);
    });

    it('CONTROL: Open agent → and Files → still navigate to their routes', () => {
        mount();
        click(door('agent'));
        click(door('files'));
        expect(navigations).toEqual(['genie://agent/a_fancy', 'genie://workspace/fancy?files=']);
        expect(shells).toEqual([]);
    });
});
