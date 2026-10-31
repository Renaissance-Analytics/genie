import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import type { AgentRecord } from '../core/identity.js';
import { addTab, clearCell, LAYOUTS, PANEL_KINDS, parseTabs, placePanel, removeTab, renameTab, serializeTabs, setLayout, type LayoutId, type Panel, type PanelKind, type TabsState, type WorkspaceTab } from '../core/workspace-tabs.js';
import { callerFrom } from './mcp-callers.js';
import { MIRRORED_TERMINAL_ID, type Caller, type McpCall, type Registration } from './mcp-tools.js';

/**
 * `workspaceTabs` — AGENTS MANAGE THE WORKSPACE'S TABS (beta.35 item 36, step 6; genie#1036: civi was asked to "add the
 * site as a panel in this workspace" and had no tool). The owner (FTQ q_227d0bb6): the workspace's DEFAULT agent has it;
 * any other agent only when its "May manage workspace tabs" switch is on (AgentRecord `manageTabs`). Everyone else does
 * not see it (prism-mcp-server's per-request `visible`), and the handler checks again.
 *
 * `list` asks nobody. Every change is checked first — an unknown tab, a cell the layout has not got, a kind Genie has
 * not got, a site this workspace does not serve: refused in words, nobody asked, nothing written — then waits for the
 * person (the approval queue; an agent whose “May manage workspace tabs” switch is on, or an Autonomous one, goes through and is recorded — genie#1294), then is
 * written to the workspace's `workspace_tabs` setting, which every window reloads at once.
 */

export const WORKSPACE_TABS_ACTION = 'workspace.tabs';

export interface WorkspaceTabsToolDeps {
    /** A caller's session key (or terminal id) → the caller; `null` for one Genie does not know. */
    readonly resolveCaller: (key: string) => Caller | null;
    readonly defaultAgentOf: (workspaceId: string) => string | null;
    readonly roster: () => readonly AgentRecord[];
    /** The workspace's `workspace_tabs` setting, raw. */
    readonly readTabs: (workspaceId: string) => string;
    readonly writeTabs: (workspaceId: string, raw: string) => void;
    /** The `.gen` hosts this workspace's sites are served at — what a `site` panel may show. */
    readonly sites: (workspaceId: string) => readonly string[];
    readonly approve: (caller: Caller, action: typeof WORKSPACE_TABS_ACTION, detail: string, call: McpCall | undefined) => Promise<'allowed' | 'denied'>;
}

const ok = (payload: Record<string, unknown>): McpToolResult => ({ text: JSON.stringify({ ok: true, ...payload }), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });

const ACTIONS = ['list', 'add', 'rename', 'remove', 'layout', 'place', 'clear'] as const;
const LAYOUT_IDS = LAYOUTS.map((l) => l.id);
const describePanel = (p: Panel): string => `${p.kind}${p.ref ? ` ${p.ref}` : ''}`;

export function workspaceTabsTools(deps: WorkspaceTabsToolDeps): Registration[] {
    const mayManage = (caller: Caller | null): boolean =>
        caller !== null && (deps.defaultAgentOf(caller.workspaceId) === caller.agentId || deps.roster().some((a) => a.id === caller.agentId && a.manageTabs === true));

    const tool: Registration = {
        definition: new ToolDefinition(
            'workspaceTabs',
            'Manage your workspace’s tabs — the ones the person sees in its tab strip, each a grid of panels (terminal, files, site, artboard, widget). `list` shows the tabs, the layouts, the panel kinds and the sites a site panel can show. `add {name}`, `rename {tab, name}`, `remove {tab}`, `layout {tab, layout}`, `place {tab, cell, kind, ref}` (cell counts from 0; a site panel’s ref is one of the listed sites), `clear {tab, cell}`. Every change asks the person unless your “May manage workspace tabs” switch is on or you are autonomous.',
            {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: [...ACTIONS] },
                    tab: { type: 'string', description: 'A tab id from list.' },
                    name: { type: 'string' },
                    layout: { type: 'string', enum: LAYOUT_IDS },
                    cell: { type: 'number', description: 'The panel’s place in the grid, counted from 0 in reading order.' },
                    kind: { type: 'string', enum: [...PANEL_KINDS] },
                    ref: { type: 'string', description: 'Which one: a site’s host (tynn.gen), a terminal id, a folder; leave it out to choose in Genie.' },
                    terminalId: MIRRORED_TERMINAL_ID,
                },
                required: ['action'],
            },
            'Workspace tabs',
        ),
        visible: ({ headers }) => {
            const key = headers['mcp-param-genie-session'] ?? headers['genie-session'];
            return typeof key === 'string' && mayManage(deps.resolveCaller(key));
        },
        handler: async (args: JsonObject, context) => {
            const found = callerFrom(args, context.headers, deps.resolveCaller);
            if (typeof found === 'string') return err(found);
            // The handler's own check — never trusting that only the right caller can reach it.
            if (!mayManage(found)) return err('Only this workspace’s default agent, or an agent whose “May manage workspace tabs” switch is on, manages its tabs.');
            const ws = found.workspaceId;
            const action = typeof args.action === 'string' ? args.action : '';
            if (!(ACTIONS as readonly string[]).includes(action)) return err(`action is one of ${ACTIONS.join(', ')}`);
            const state = parseTabs(deps.readTabs(ws));

            if (action === 'list') {
                return ok({ tabs: state.tabs, layouts: LAYOUT_IDS, panelKinds: PANEL_KINDS, sites: deps.sites(ws) });
            }

            const plan = planChange(action, args, state, deps.sites(ws));
            if ('error' in plan) return err(plan.error);
            if ((await deps.approve(found, WORKSPACE_TABS_ACTION, plan.detail, context)) !== 'allowed') return err('The person declined: the tabs are as they were.');
            deps.writeTabs(ws, serializeTabs(plan.next));
            const tab = plan.next.tabs.find((t) => t.id === plan.tabId) ?? null;
            return ok({ ...(tab ? { tab } : {}), ...(plan.dropped.length > 0 ? { dropped: plan.dropped } : {}) });
        },
    };
    return [tool];
}

type Planned = { next: TabsState; tabId: string; detail: string; dropped: Panel[] } | { error: string };

/** What a change would do — or why Genie refuses it — before anyone is asked. */
function planChange(action: string, args: JsonObject, state: TabsState, sites: readonly string[]): Planned {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (action === 'add') {
        if (name === '') return { error: 'a new tab needs a name' };
        const { state: next, id } = addTab(state, name);
        return { next, tabId: id, detail: `Add a tab “${name}”`, dropped: [] };
    }
    const tabId = typeof args.tab === 'string' ? args.tab : '';
    const tab: WorkspaceTab | undefined = state.tabs.find((t) => t.id === tabId);
    if (!tab) return { error: `no tab ${tabId || '(none given)'} in this workspace; list shows its tabs (${state.tabs.map((t) => t.id).join(', ') || 'none yet'})` };
    const cellArg = (): number | string => {
        const cell = typeof args.cell === 'number' && Number.isInteger(args.cell) ? args.cell : -1;
        return cell >= 0 && cell < tab.cells.length ? cell : `panel ${cell + 1} is not in “${tab.name}”: its layout has ${tab.cells.length}`;
    };
    switch (action) {
        case 'rename':
            if (name === '') return { error: 'a tab’s name cannot be blank' };
            return { next: renameTab(state, tab.id, name), tabId: tab.id, detail: `Rename the tab “${tab.name}” to “${name}”`, dropped: [] };
        case 'remove':
            return { next: removeTab(state, tab.id), tabId: tab.id, detail: `Remove the tab “${tab.name}” and its panels`, dropped: [] };
        case 'layout': {
            const layout = typeof args.layout === 'string' ? args.layout : '';
            if (!LAYOUT_IDS.includes(layout as LayoutId)) return { error: `layout is one of ${LAYOUT_IDS.join(', ')}` };
            const { state: next, dropped } = setLayout(state, tab.id, layout as LayoutId);
            const label = LAYOUTS.find((l) => l.id === layout)!.label;
            const drops = dropped.length > 0 ? ` — drops ${dropped.length} panel${dropped.length === 1 ? '' : 's'}: ${dropped.map(describePanel).join(', ')}` : '';
            return { next, tabId: tab.id, detail: `Lay out the tab “${tab.name}” as ${label}${drops}`, dropped };
        }
        case 'place': {
            const cell = cellArg();
            if (typeof cell === 'string') return { error: cell };
            const kind = typeof args.kind === 'string' ? args.kind : '';
            if (!(PANEL_KINDS as readonly string[]).includes(kind)) return { error: `a panel is one of ${PANEL_KINDS.join(', ')}` };
            const ref = typeof args.ref === 'string' && args.ref.trim() !== '' ? args.ref.trim() : null;
            if (kind === 'site' && ref !== null && !sites.includes(ref)) return { error: `${ref} is not a site this workspace serves (${sites.join(', ') || 'none yet — add one with the sites tool'})` };
            const panel: Panel = { kind: kind as PanelKind, ref };
            const what = kind === 'site' && ref ? `the site ${ref}` : `a ${kind} panel${ref ? ` (${ref})` : ''}`;
            return { next: placePanel(state, tab.id, cell, panel), tabId: tab.id, detail: `Show ${what} in the tab “${tab.name}”, panel ${cell + 1}`, dropped: [] };
        }
        case 'clear': {
            const cell = cellArg();
            if (typeof cell === 'string') return { error: cell };
            return { next: clearCell(state, tab.id, cell), tabId: tab.id, detail: `Empty panel ${cell + 1} of the tab “${tab.name}”`, dropped: [] };
        }
    }
    return { error: `action is one of ${ACTIONS.join(', ')}` };
}
