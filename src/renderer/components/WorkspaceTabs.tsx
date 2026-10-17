import { Icon } from '@particle-academy/react-fancy';
import { tabStrip, type TabsState } from '../../core/workspace-tabs.js';

/**
 * A WORKSPACE'S TAB STRIP (Tynn #282, #805): Agents · the agents you opened · the tabs you designed · + · Settings — +
 * always just before Settings, Settings always last. The SAME strip on the workspace's own views and over an agent's
 * page: an agent opens INSIDE its workspace (the owner's choice, 2026-10-17 — as in Genie 1), so the workspace, its
 * tabs, Settings and the sibling agents are always one click away. Labelled tabs, never a shortcut-only door (§4.0).
 */
export interface WorkspaceTabsProps {
    readonly designed: TabsState;
    /** The agents open as tabs here, in the order opened (core/workspace-tabs.ts `openAgentTabs`). */
    readonly openAgents: ReadonlyArray<{ id: string; name: string; state: string }>;
    /** What is on screen: an agent's page, or one of the workspace's views (`home`, `tab:<id>`, `settings`, …). */
    readonly current: { kind: 'agent'; id: string } | { kind: 'view'; view: string };
    /** The + needs somewhere to keep a tab; a + that could not keep anything is not offered. */
    readonly canDesign: boolean;
    readonly hasSettings: boolean;
    readonly onView: (view: string) => void;
    readonly onAdd: () => void;
    readonly onOpenAgent: (agentId: string) => void;
    readonly onCloseAgent: (agentId: string) => void;
}

const STATE_DOT: Record<string, string> = {
    working: 'bg-[var(--accent)]',
    waiting: 'bg-[var(--warning)]',
    broken: 'bg-[var(--danger)]',
};

export function WorkspaceTabs({ designed, openAgents, current, canDesign, hasSettings, onView, onAdd, onOpenAgent, onCloseAgent }: WorkspaceTabsProps) {
    const tab = (on: boolean) => `border-b-2 px-3 text-[12px] ${on ? 'border-[var(--fg-1)] text-[var(--fg-1)]' : 'border-transparent text-[var(--fg-3)] hover:text-[var(--fg-1)]'}`;
    return (
        <nav data-workspace-tabs="" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-[var(--border-1)] bg-[var(--bg-1)] px-3">
            {tabStrip(designed, openAgents).filter((t) => (t.kind === 'add' ? canDesign : t.kind === 'settings' ? hasSettings : true)).map((t) => {
                if (t.kind === 'add') {
                    return (
                        <button key="add" type="button" data-workspace-tab="add" aria-label="New tab" title="New tab — design it with panels" onClick={onAdd} className="flex items-center border-b-2 border-transparent px-2 text-[var(--fg-3)] hover:text-[var(--fg-1)]">
                            <Icon name="plus" size="xs" />
                        </button>
                    );
                }
                if (t.kind === 'agent') {
                    const on = current.kind === 'agent' && current.id === t.id;
                    const state = openAgents.find((a) => a.id === t.id)?.state ?? 'idle';
                    return (
                        <span key={`agent:${t.id}`} className={`group flex shrink-0 items-center gap-1 ${tab(on)}`}>
                            <button type="button" data-workspace-tab={`agent:${t.id}`} {...(on ? { 'data-current': 'true' } : {})} onClick={() => onOpenAgent(t.id)} title={`${t.name} · ${state}`} className="flex items-center gap-1.5">
                                <span data-agent-state={state} className={`size-1.5 rounded-full ${STATE_DOT[state] ?? 'bg-[var(--fg-4)]'}`} />
                                {t.name}
                            </button>
                            <button type="button" data-close-agent-tab={t.id} aria-label={`Close ${t.name}`} title={`Close ${t.name}'s tab`} onClick={() => onCloseAgent(t.id)} className="rounded px-0.5 text-[var(--fg-4)] opacity-60 hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)] group-hover:opacity-100">
                                <Icon name="x" size="xs" />
                            </button>
                        </span>
                    );
                }
                const view = t.kind === 'agents' ? 'home' : t.kind === 'settings' ? 'settings' : `tab:${t.id}`;
                const on = current.kind === 'view' && current.view === view;
                return (
                    <button key={view} type="button" data-workspace-tab={view} {...(on ? { 'data-current': 'true' } : {})} onClick={() => onView(view)} className={tab(on)}>
                        {t.kind === 'designed' ? t.name : t.kind === 'agents' ? 'Agents' : 'Settings'}
                    </button>
                );
            })}
        </nav>
    );
}
