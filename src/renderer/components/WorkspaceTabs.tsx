import { Icon } from '@particle-academy/react-fancy';
import { tabStrip, type TabsState } from '../../core/workspace-tabs.js';

/**
 * A WORKSPACE'S TAB STRIP (Tynn #282, #805): Dashboard · every agent of the workspace · the tabs you designed · + · Settings — +
 * always just before Settings, Settings always last. The SAME strip on the workspace's own views and over an agent's
 * page: an agent opens INSIDE its workspace (the owner's choice, 2026-10-17 — as in Genie 1), so the workspace, its
 * tabs, Settings and the sibling agents are always one click away. Labelled tabs, never a shortcut-only door (§4.0).
 */
export interface WorkspaceTabsProps {
    readonly designed: TabsState;
    /** Every agent of the workspace, running or not (core/workspace-tabs.ts `agentTabsOf`). */
    readonly agents: ReadonlyArray<{ id: string; name: string; state: string }>;
    /** What is on screen: an agent's page, or one of the workspace's views (`home`, `tab:<id>`, `settings`, …). */
    readonly current: { kind: 'agent'; id: string } | { kind: 'view'; view: string };
    /** The + needs somewhere to keep a tab; a + that could not keep anything is not offered. */
    readonly canDesign: boolean;
    readonly hasSettings: boolean;
    /** The workspace is linked to a Tynn project: its GitHub (IssueWatch) view has something to show (Tynn #806). */
    readonly github?: boolean;
    readonly onView: (view: string) => void;
    readonly onAdd: () => void;
    readonly onOpenAgent: (agentId: string) => void;
}

const STATE_DOT: Record<string, string> = {
    working: 'bg-[var(--accent)]',
    waiting: 'bg-[var(--warning)]',
    broken: 'bg-[var(--danger)]',
};

export function WorkspaceTabs({ designed, agents, current, canDesign, hasSettings, github = false, onView, onAdd, onOpenAgent }: WorkspaceTabsProps) {
    const tab = (on: boolean) => `border-b-2 px-3 text-[12px] ${on ? 'border-[var(--fg-1)] text-[var(--fg-1)]' : 'border-transparent text-[var(--fg-3)] hover:text-[var(--fg-1)]'}`;
    return (
        <nav data-workspace-tabs="" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-[var(--border-1)] bg-[var(--bg-1)] px-3">
            {tabStrip(designed, agents, { github }).filter((t) => (t.kind === 'add' ? canDesign : t.kind === 'settings' ? hasSettings : true)).map((t) => {
                if (t.kind === 'add') {
                    return (
                        <button key="add" type="button" data-workspace-tab="add" aria-label="New tab" title="New tab — design it with panels" onClick={onAdd} className="flex items-center border-b-2 border-transparent px-2 text-[var(--fg-3)] hover:text-[var(--fg-1)]">
                            <Icon name="plus" size="xs" />
                        </button>
                    );
                }
                if (t.kind === 'agent') {
                    const on = current.kind === 'agent' && current.id === t.id;
                    const state = agents.find((a) => a.id === t.id)?.state ?? 'idle';
                    return (
                        <button key={`agent:${t.id}`} type="button" data-workspace-tab={`agent:${t.id}`} {...(on ? { 'data-current': 'true' } : {})} onClick={() => onOpenAgent(t.id)} title={`${t.name} · ${state}`} className={`flex shrink-0 items-center gap-1.5 ${tab(on)}`}>
                            <span data-agent-state={state} className={`size-1.5 rounded-full ${STATE_DOT[state] ?? 'bg-[var(--fg-4)]'}`} />
                            {t.name}
                        </button>
                    );
                }
                const view = t.kind === 'dashboard' ? 'home' : t.kind === 'settings' ? 'settings' : t.kind === 'github' ? 'github' : t.kind === 'files' ? 'files' : `tab:${t.id}`;
                const on = current.kind === 'view' && current.view === view;
                return (
                    <button key={view} type="button" data-workspace-tab={view} {...(on ? { 'data-current': 'true' } : {})} onClick={() => onView(view)} className={tab(on)}>
                        {t.kind === 'designed' ? t.name : t.kind === 'dashboard' ? 'Dashboard' : t.kind === 'github' ? 'GitHub' : t.kind === 'files' ? 'Files' : 'Settings'}
                    </button>
                );
            })}
        </nav>
    );
}
