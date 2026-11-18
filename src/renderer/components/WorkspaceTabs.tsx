import { Button, Icon, Tabs } from '@particle-academy/react-fancy';
import type { ReactNode } from 'react';
import { tabStrip, type TabsState } from '../../core/workspace-tabs.js';
import { TynnLogo } from './TynnLogo.js';
import { wsStyle } from '../workspace-colors.js';
import { BAR_ACTION, TopBar } from './TopBar.js';

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
    /** The workspace is linked to a Tynn project: its Tynn tab (genie#1295). */
    readonly tynn?: boolean;
    /** This window's host can measure the workspace's disk: its Storage tab (Tynn #697). */
    readonly storage?: boolean;
    /** Items on the ArtBoard waiting for a verdict (Tynn #739): the tab shows the count and is flagged. 0 or absent = no badge. */
    readonly artboardWaiting?: number | undefined;
    readonly onView: (view: string) => void;
    readonly onAdd: () => void;
    readonly onOpenAgent: (agentId: string) => void;
    /**
     * The Active Plan column's toggle (beta.33 item 11; the owner: "a button in the top right of the workspace tab row that
     * opens and hides it") — given only on an agent's page that HAS the column; absent = no button.
     */
    readonly planToggle?: { readonly open: boolean; readonly onToggle: () => void } | undefined;
    /**
     * The workspace's colour (genie#1300): the strip's left edge, and the underline of the tab on screen — the workspace
     * view or the agent — so the agent you are on is shown in its workspace's colour. Absent/`null` = drawn as before.
     */
    readonly color?: string | null | undefined;
    /** Share this workspace through Tynn (Tynn #587): in the strip, so it is there whatever is selected. Absent for a guest. */
    readonly onShare?: (() => void) | undefined;
    /**
     * What is selected puts its status, its own views and its actions at the bar's right end (TopBar.tsx): the workspace's
     * actions, or the agent's state, Stream/Changes/Shells/Settings and Chat/Take over. Absent = nothing there but Share/Plan.
     */
    readonly trailing?: ReactNode;
    /** The selected tab's path (the workspace's folder, the agent's cwd): its tooltip, never a column of the bar. */
    readonly path?: string | null | undefined;
}

/** The selected tab's tooltip is the path (the owner: no path column eating space). */
const pathTitle = (selected: boolean, path: string | null): Record<string, string> => (selected && path ? { title: path } : {});

/**
 * THE SELECTED TAB STAYS IN VIEW (scripts/one-bar-proof.mjs, 1600px with the chat pinned: the agent's own tab was scrolled
 * out of the strip). A marker inside the selected tab; React calls this when the marker is attached, i.e. when the
 * selection moves, never on a re-render, so it never fights a person scrolling the strip themselves.
 */
const SHOW_SELECTED = (el: HTMLSpanElement | null): void => { el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); };

const STATE_DOT: Record<string, string> = {
    working: 'bg-[var(--accent)]',
    waiting: 'bg-[var(--warning)]',
    broken: 'bg-[var(--danger)]',
};

export function WorkspaceTabs({ designed, agents, current, canDesign, hasSettings, github = false, tynn = false, storage = false, artboardWaiting = 0, onView, onAdd, onOpenAgent, planToggle, color = null, onShare, trailing, path = null }: WorkspaceTabsProps) {
    // Literal classes, dark: included: react-fancy's underline tab carries its own dark: colours, and only a class with the
    // same variant replaces one.
    const underline = color ? 'border-[var(--ws)] dark:border-[var(--ws)]' : 'border-[var(--fg-1)] dark:border-[var(--fg-1)]';
    // The tab on screen: the agent's page, or the workspace view. react-fancy Tabs marks it (role="tab", aria-selected) and
    // moves between tabs with the arrow keys; the route stays the source of truth, so a pick navigates and nothing else.
    const selected = current.kind === 'agent' ? `agent:${current.id}` : current.view;
    const tab = (on: boolean) => `border-b-2 px-3 py-0 text-[12px] font-normal ${on ? `${underline} text-[var(--fg-1)] dark:text-[var(--fg-1)]` : 'border-transparent text-[var(--fg-3)] hover:border-transparent hover:text-[var(--fg-1)] dark:text-[var(--fg-3)] dark:hover:text-[var(--fg-1)]'}`;
    const tail = (
        <>
            {trailing}
            {onShare ? (
                <Button variant="ghost" size="xs" labelClassName="contents" type="button" data-action="share-workspace" aria-label="Share this workspace" title="Share: a link someone opens to reach this workspace over Tynn, control or read-only, for as long as you choose" onClick={onShare} className={BAR_ACTION}>
                    <Icon name="share-2" size="xs" />
                </Button>
            ) : null}
            {planToggle ? (
                <Button variant="ghost" size="xs" labelClassName="contents" type="button" data-action="toggle-plan-column" aria-pressed={planToggle.open ? 'true' : 'false'} aria-label={planToggle.open ? 'Hide the active plan' : 'Show the active plan'} title={planToggle.open ? 'Hide the active plan' : 'Show the active plan'} onClick={planToggle.onToggle} className={`${BAR_ACTION}${planToggle.open ? ' text-[var(--fg-1)]' : ''}`}>
                    <Icon name={planToggle.open ? 'panel-right-close' : 'panel-right-open'} size="xs" />
                </Button>
            ) : null}
        </>
    );
    return (
        <TopBar color={color} style={wsStyle(color)} attrs={{ 'data-workspace-tabs': '', ...(color ? { 'data-workspace-color': color } : {}) }} trailing={trailing || onShare || planToggle ? tail : null}>
            {/* TABS, NOT BUTTONS (the owner, 2026-11-01: "those should not be buttons, it's a menu"). The + stays a Button: it
                is an action, sitting where the owner put it (just before Settings); the arrow keys skip it. */}
            <Tabs activeTab={selected} onTabChange={(v) => (v.startsWith('agent:') ? onOpenAgent(v.slice('agent:'.length)) : onView(v))} className="flex min-w-0 items-stretch">
            <Tabs.List className="items-stretch border-b-0">
            {tabStrip(designed, agents, { github, tynn, storage }).filter((t) => (t.kind === 'add' ? canDesign : t.kind === 'settings' ? hasSettings : true)).map((t) => {
                if (t.kind === 'add') {
                    return (
                        <Button variant="ghost" size="xs" labelClassName="contents" key="add" type="button" data-workspace-tab="add" aria-label="New tab" title="New tab — design it with panels" onClick={onAdd} className="flex items-center border-b-2 border-transparent px-2 text-[var(--fg-3)] hover:text-[var(--fg-1)]">
                            <Icon name="plus" size="xs" />
                        </Button>
                    );
                }
                if (t.kind === 'agent') {
                    const on = current.kind === 'agent' && current.id === t.id;
                    const state = agents.find((a) => a.id === t.id)?.state ?? 'idle';
                    return (
                        <Tabs.Tab key={`agent:${t.id}`} value={`agent:${t.id}`} data-workspace-tab={`agent:${t.id}`} title={on ? `${t.name} · ${state}${path ? ` · ${path}` : ''}` : `${t.name} · ${state}`} className={`flex shrink-0 items-center gap-1.5 ${tab(on)}`}>
                            <span data-agent-state={state} className={`size-1.5 rounded-full ${STATE_DOT[state] ?? 'bg-[var(--fg-4)]'}`} />
                            {t.name}
                            {on ? <span ref={SHOW_SELECTED} aria-hidden="true" /> : null}
                        </Tabs.Tab>
                    );
                }
                const view = t.kind === 'dashboard' ? 'home' : t.kind === 'settings' ? 'settings' : t.kind === 'github' ? 'github' : t.kind === 'tynn' ? 'tynn' : t.kind === 'files' ? 'files' : t.kind === 'artboard' ? 'artboard' : t.kind === 'storage' ? 'storage' : `tab:${t.id}`;
                const on = current.kind === 'view' && current.view === view;
                return (
                    <Tabs.Tab key={view} value={view} data-workspace-tab={view} {...pathTitle(on, path)} {...(t.kind === 'artboard' && artboardWaiting > 0 ? { 'data-artboard-waiting': 'true' } : {})} className={`shrink-0 ${tab(on)}`}>
                        {t.kind === 'tynn' ? <TynnLogo /> : t.kind === 'designed' ? t.name : t.kind === 'dashboard' ? 'Dashboard' : t.kind === 'github' ? 'GitHub' : t.kind === 'files' ? 'Files' : t.kind === 'artboard' ? 'ArtBoard' : t.kind === 'storage' ? 'Storage' : 'Settings'}
                        {on ? <span ref={SHOW_SELECTED} aria-hidden="true" /> : null}
                        {t.kind === 'artboard' && artboardWaiting > 0 ? <span data-artboard-badge={String(artboardWaiting)} title={`${artboardWaiting} waiting for your verdict`} className="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--warning)] px-1 text-[10px] font-semibold leading-4 text-[var(--bg-0)]">{artboardWaiting}</span> : null}
                    </Tabs.Tab>
                );
            })}
            </Tabs.List>
            </Tabs>
        </TopBar>
    );
}
