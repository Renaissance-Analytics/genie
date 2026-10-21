import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { parseTabs, serializeTabs, addTab } from '../src/core/workspace-tabs.js';
import { workspaceTabsTools, type WorkspaceTabsToolDeps } from '../src/main/mcp-tools-workspace-tabs.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * AGENTS MANAGE THE WORKSPACE'S TABS (beta.35 item 36, step 6; genie#1036 — civi: "add the site as a panel in this
 * workspace" had no tool). The owner (FTQ q_227d0bb6): a `workspaceTabs` tool for the workspace's DEFAULT agent
 * automatically, and for any other agent only when its "May manage workspace tabs" switch is on. Everyone else does not
 * see it. Every change waits for the person (the approval queue — an Autonomous agent's goes through, as with
 * `sites update`); a change Genie would refuse is refused in words before anyone is asked; `list` asks nobody.
 */

const rec = (id: string, name: string, over: Partial<AgentRecord> = {}): AgentRecord => ({ id, name, workspaceId: 'tynn', provider: 'claude', instructions: null, threadId: null, createdAt: '2026-10-21T00:00:00Z', lastUsedAt: null, mode: 'manual', accessScope: 'self', ...over } as AgentRecord);
const CALLERS: Record<string, Caller> = {
    'k-atlas': { agentId: 'a1', agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' } as Caller,
    'k-wren': { agentId: 'a2', agentName: 'wren', workspaceId: 'tynn', workspacePath: '/w/tynn' } as Caller,
    'k-kite': { agentId: 'a3', agentName: 'kite', workspaceId: 'tynn', workspacePath: '/w/tynn' } as Caller,
};

function harness(over: { verdict?: 'allowed' | 'denied'; tabs?: string } = {}) {
    const roster = [rec('a1', 'atlas'), rec('a2', 'wren', { manageTabs: true }), rec('a3', 'kite')];
    let stored = over.tabs ?? '{"tabs":[]}';
    const asked: Array<{ caller: string; action: string; detail: string }> = [];
    const writes: string[] = [];
    const deps: WorkspaceTabsToolDeps = {
        resolveCaller: (key) => CALLERS[key] ?? null,
        defaultAgentOf: (ws) => (ws === 'tynn' ? 'a1' : null),
        roster: () => roster,
        readTabs: () => stored,
        writeTabs: (_ws, raw) => { stored = raw; writes.push(raw); },
        sites: () => ['tynn.gen', 'moic.gen'],
        approve: async (caller, action, detail) => { asked.push({ caller: caller.agentName, action, detail }); return over.verdict ?? 'allowed'; },
    };
    const [tool] = workspaceTabsTools(deps);
    const call = async (key: string, args: Record<string, unknown>) => JSON.parse((await tool!.handler(args as never, { headers: { 'genie-session': key } } as never)).text) as Record<string, any>;
    return { tool: tool!, asked, writes, call, stored: () => parseTabs(stored) };
}

describe('who sees workspaceTabs', () => {
    it('the default agent, and an agent whose switch is on; one whose switch is off, an unknown session, none: no', async () => {
        const h = harness();
        expect(h.tool.definition.name).toBe('workspaceTabs');
        const sees = (key?: string) => h.tool.visible!({ headers: key ? { 'mcp-param-genie-session': key } : {} });
        expect(await sees('k-atlas')).toBe(true);
        expect(await sees('k-wren')).toBe(true);
        expect(await sees('k-kite')).toBe(false);
        expect(await sees('k-nobody')).toBe(false);
        expect(await sees()).toBe(false);
    });

    it('the handler checks again: an agent without the switch is refused and nothing is written', async () => {
        const h = harness();
        const out = await h.call('k-kite', { action: 'add', name: 'Ops' });
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/May manage workspace tabs/);
        expect(h.writes).toEqual([]);
        expect(h.asked).toEqual([]);
    });
});

describe('what it does', () => {
    it('list: the tabs as they are, the layouts and panel kinds there are, and the sites a panel can show — asking nobody', async () => {
        const h = harness({ tabs: serializeTabs(addTab({ tabs: [] }, 'Ops').state) });
        const out = await h.call('k-atlas', { action: 'list' });
        expect(out.ok).toBe(true);
        expect(out.tabs).toEqual([{ id: 'tab-1', name: 'Ops', layout: 'single', cells: [null] }]);
        expect(out.layouts).toContain('columns-2');
        expect(out.panelKinds).toEqual(['terminal', 'files', 'site', 'artboard', 'widget']);
        expect(out.sites).toEqual(['tynn.gen', 'moic.gen']);
        expect(h.asked).toEqual([]);
    });

    it('add, then layout, then place a SITE panel (genie#1036) — each asked of the person, each written, the tab answered', async () => {
        const h = harness();
        const added = await h.call('k-atlas', { action: 'add', name: 'Ops' });
        expect(added).toMatchObject({ ok: true, tab: { id: 'tab-1', name: 'Ops' } });
        await h.call('k-atlas', { action: 'layout', tab: 'tab-1', layout: 'columns-2' });
        const placed = await h.call('k-atlas', { action: 'place', tab: 'tab-1', cell: 1, kind: 'site', ref: 'moic.gen' });
        expect(placed.tab.cells).toEqual([null, { kind: 'site', ref: 'moic.gen' }]);
        expect(h.stored().tabs[0]).toEqual({ id: 'tab-1', name: 'Ops', layout: 'columns-2', cells: [null, { kind: 'site', ref: 'moic.gen' }] });
        expect(h.asked.map((a) => a.action)).toEqual(['workspace.tabs', 'workspace.tabs', 'workspace.tabs']);
        expect(h.asked[2]!.detail).toBe('Show the site moic.gen in the tab “Ops”, panel 2');
    });

    it('rename, clear and remove', async () => {
        const start = addTab({ tabs: [] }, 'Ops').state;
        const h = harness({ tabs: serializeTabs(start) });
        await h.call('k-wren', { action: 'place', tab: 'tab-1', cell: 0, kind: 'files', ref: null });
        await h.call('k-wren', { action: 'rename', tab: 'tab-1', name: 'Board' });
        await h.call('k-wren', { action: 'clear', tab: 'tab-1', cell: 0 });
        expect(h.stored().tabs[0]).toEqual({ id: 'tab-1', name: 'Board', layout: 'single', cells: [null] });
        await h.call('k-wren', { action: 'remove', tab: 'tab-1' });
        expect(h.stored().tabs).toEqual([]);
    });

    it('a smaller layout says which panels it would drop, in the question and the answer', async () => {
        const h = harness();
        await h.call('k-atlas', { action: 'add', name: 'Ops' });
        await h.call('k-atlas', { action: 'layout', tab: 'tab-1', layout: 'columns-2' });
        await h.call('k-atlas', { action: 'place', tab: 'tab-1', cell: 1, kind: 'site', ref: 'tynn.gen' });
        const out = await h.call('k-atlas', { action: 'layout', tab: 'tab-1', layout: 'single' });
        expect(out.dropped).toEqual([{ kind: 'site', ref: 'tynn.gen' }]);
        expect(h.asked[h.asked.length - 1]!.detail).toMatch(/drops 1 panel: site tynn\.gen/);
    });
});

describe('refused before anyone is asked, nothing written', () => {
    const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
        ['an unknown tab', { action: 'rename', tab: 'tab-9', name: 'X' }, /no tab tab-9/],
        ['a cell the layout does not have', { action: 'place', tab: 'tab-1', cell: 3, kind: 'files', ref: null }, /panel 4.*has 1/],
        ['a panel kind Genie does not have', { action: 'place', tab: 'tab-1', cell: 0, kind: 'iframe', ref: null }, /terminal, files, site, artboard, widget/],
        ['a site this workspace does not serve', { action: 'place', tab: 'tab-1', cell: 0, kind: 'site', ref: 'example.com' }, /example\.com is not a site this workspace serves/],
        ['a layout there is not', { action: 'layout', tab: 'tab-1', layout: 'columns-9' }, /single, columns-2/],
        ['a blank name', { action: 'rename', tab: 'tab-1', name: '  ' }, /name/],
        ['an action there is not', { action: 'explode' }, /list, add, rename, remove, layout, place, clear/],
    ];
    for (const [what, args, says] of refusals) {
        it(what, async () => {
            const h = harness({ tabs: serializeTabs(addTab({ tabs: [] }, 'Ops').state) });
            const out = await h.call('k-atlas', args);
            expect(out.ok).toBe(false);
            expect(out.error).toMatch(says);
            expect(h.asked).toEqual([]);
            expect(h.writes).toEqual([]);
        });
    }

    it('the person declines: nothing is written', async () => {
        const h = harness({ verdict: 'denied' });
        const out = await h.call('k-atlas', { action: 'add', name: 'Ops' });
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/declined/);
        expect(h.writes).toEqual([]);
    });

    it('CONTROL: the same add, allowed, is written', async () => {
        const h = harness();
        expect((await h.call('k-atlas', { action: 'add', name: 'Ops' })).ok).toBe(true);
        expect(h.writes).toHaveLength(1);
    });
});
