import { Icon } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { deckBadge, filterRail, type RailItem, type RailSurface } from '../../core/rail-view.js';
import { folderName } from '../../core/workspace-name.js';

export type { RailSurface };

/**
 * THE RAIL — 208px, persistent, labelled.
 *
 * ```
 *   ▣  Deck                      ⟨amber count badge⟩
 *   ▤  Dashboard                 ⟨active row⟩
 *   ◆  genie                     ⟨the OS agent — always present⟩
 *
 *   WORKSPACES
 *   ▸  tynn                ●  4
 *   ▸  fancy                  6
 * ```
 *
 * ## The acceptance bar this exists to clear
 *
 * *A person who has never used Genie, given no instructions, reaches the Dashboard and opens
 * an agent within thirty seconds.* **If that needs a keyboard shortcut, it fails.** So every
 * destination here is a labelled control with the word a newcomer would look for, and ⌘K is
 * an accelerator beside it rather than the way in.
 *
 * ## Active is read from the ROUTE
 *
 * Not from a `selected` prop the shell remembers. All view state lives in the URL, so refresh,
 * back and a deep link an agent sent all agree with the rail without anything synchronising.
 */

export interface SidebarProps {
    /** The current route. The active row is derived from it, never tracked separately. */
    route: string;
    /** Things waiting on a human. `0` shows no badge; `null` means the queue is unread. */
    deckCount: number | null;
    workspaces: readonly RailItem[];
    /**
     * Which rows this build can actually render a surface for.
     *
     * A surface that is not here is **omitted**, not disabled. *"A disabled control is an
     * accusation; a different shape is a fact"* — and a rail offering a route the shell cannot
     * serve is the previous attempt's "built and unreachable" with the arrow reversed.
     *
     * It exists because the build lands in phases and each phase has to leave the app usable.
     * The row returns when its surface does, and nothing else about the rail changes.
     */
    available: readonly RailSurface[];
    onNavigate: (route: string) => void;
    /** Add a workspace (Tynn #283): the `+` in the rail's tools, any time. Absent = no `+` (a control that does nothing is not offered). */
    onAddWorkspace?: (() => void) | undefined;
    /** Where the collapsed state is remembered; `undefined` = the window's localStorage, `null` = nowhere (tests pass their own). */
    railStorage?: Pick<Storage, 'getItem' | 'setItem'> | null | undefined;
}

const ROW =
    'flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-[13px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]';
const ROW_ACTIVE = 'bg-[var(--bg-3)] font-medium text-[var(--fg-1)]';

function NavRow({
    route,
    current,
    icon,
    label,
    onNavigate,
    children,
    compact = false,
}: {
    route: string;
    current: string;
    icon: string;
    label: string;
    onNavigate: (route: string) => void;
    children?: React.ReactNode;
    /** Collapsed rail: the icon alone, the label as its tooltip and accessible name. */
    compact?: boolean;
}) {
    // A route carries query state (`?group=workspace`), so the comparison is on the path.
    // Matching the whole string would un-highlight the Dashboard the moment someone regrouped
    // it, which reads as having navigated away from a surface you are still looking at.
    const active = current.split('?')[0] === route;

    return (
        <button
            type="button"
            data-nav={route}
            data-active={active ? 'true' : 'false'}
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(route)}
            {...(compact ? { 'aria-label': label, title: label } : {})}
            className={`${compact ? ICON_BUTTON : ROW} relative ${active ? ROW_ACTIVE : ''}`}
        >
            <Icon name={icon} size="sm" className="shrink-0 text-[var(--fg-4)]" />
            {compact ? null : <span className="truncate">{label}</span>}
            {children}
        </button>
    );
}

const ICON_BUTTON = 'flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]';

/** Where the rail remembers whether it is collapsed — this device's preference (Tynn #799). */
const COLLAPSED_KEY = 'genie.rail.collapsed';

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
    try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** Where the rail remembers whether hibernated workspaces are shown — this device's preference, not the host's. */
const SHOW_ASLEEP_KEY = 'genie.rail.showHibernated';

function readShowAsleep(): boolean {
    try { return typeof window !== 'undefined' && window.localStorage.getItem(SHOW_ASLEEP_KEY) === '1'; } catch { return false; }
}

export function Sidebar({ route, deckCount, workspaces, available, onNavigate, onAddWorkspace, railStorage }: SidebarProps) {
    const has = (s: RailSurface): boolean => available.includes(s);
    const storage = railStorage === undefined ? browserStorage() : railStorage;
    // COLLAPSED (Tynn #799): an icon rail where every destination is still one click away; remembered on this device.
    const [collapsed, setCollapsed] = useState(() => { try { return storage?.getItem(COLLAPSED_KEY) === '1'; } catch { return false; } });
    const setRail = (next: boolean): void => {
        setCollapsed(next);
        try { storage?.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* a preference that cannot be saved still applies now */ }
    };
    // THE FILTER (Genie 1's "Search workspaces…", Tynn #282): narrows the workspace rows by name or path.
    const [query, setQuery] = useState('');
    // Hibernated workspaces are hidden by default; the one being looked at is never hidden from under the reader.
    const [showAsleep, setShowAsleep] = useState(readShowAsleep);
    const toggleAsleep = (): void => {
        const next = !showAsleep;
        setShowAsleep(next);
        try { window.localStorage.setItem(SHOW_ASLEEP_KEY, next ? '1' : '0'); } catch { /* a preference that cannot be saved still applies now */ }
    };
    const current = route.split('?')[0];
    // No orphan badge: the Deck's count has nowhere to live without the Deck.
    const badge = has('deck') ? deckBadge(deckCount) : null;
    const asleepCount = workspaces.filter((w) => w.asleep === true).length;
    const shown = filterRail(workspaces.filter((w) => showAsleep || w.asleep !== true || current === `genie://workspace/${w.id}`), collapsed ? '' : query);
    const asleepLabel = `${showAsleep ? 'Hide' : 'Show'} ${asleepCount} hibernated workspace${asleepCount === 1 ? '' : 's'}`;
    // THE HIBERNATED TOOL (Tynn #282): an eye, no words — its count and action are its name and tooltip.
    const asleepTool = asleepCount > 0 ? (
        <button type="button" data-rail-tool="hibernated" data-toggle-asleep={showAsleep ? 'hide' : 'show'} aria-label={asleepLabel} title={asleepLabel} aria-pressed={showAsleep} onClick={toggleAsleep} className={ICON_BUTTON}>
            <Icon name={showAsleep ? 'eye' : 'eye-off'} size="sm" />
        </button>
    ) : null;
    const addTool = onAddWorkspace ? (
        <button type="button" data-rail-tool="add-workspace" aria-label="Add workspace" title="Add workspace" onClick={() => onAddWorkspace()} className={ICON_BUTTON}>
            <Icon name="plus" size="sm" />
        </button>
    ) : null;
    // System (Genie 1's monitor-cog): the system agent — Genie's own, never in a workspace.
    const systemTool = has('genie') ? (
        <button type="button" data-rail-tool="system" aria-label="System" title="System" onClick={() => onNavigate('genie://agent/genie')} className={ICON_BUTTON}>
            <Icon name="monitor-cog" size="sm" />
        </button>
    ) : null;

    if (collapsed) {
        return (
            <nav aria-label="Genie" data-rail="collapsed" className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[var(--border-1)] bg-[var(--bg-1)] py-2.5">
                <button type="button" data-rail-tool="expand" aria-label="Expand sidebar" title="Expand sidebar" onClick={() => setRail(false)} className={ICON_BUTTON}>
                    <Icon name="panel-left-open" size="sm" />
                </button>
                {has('deck') ? (
                    <NavRow route="genie://deck" current={route} icon="inbox" label={badge !== null ? `Deck · ${badge}` : 'Deck'} onNavigate={onNavigate} compact>
                        {badge !== null ? <span data-deck-dot="" className="absolute right-1 top-1 size-1.5 rounded-full bg-[var(--warning)]" /> : null}
                    </NavRow>
                ) : null}
                {has('dashboard') ? <NavRow route="genie://dashboard" current={route} icon="layout-list" label="Dashboard" onNavigate={onNavigate} compact /> : null}
                {has('genie') ? <NavRow route="genie://agent/genie" current={route} icon="sparkles" label="genie" onNavigate={onNavigate} compact /> : null}
                {has('hosting') ? <NavRow route="genie://hosting" current={route} icon="server" label="Hosting" onNavigate={onNavigate} compact /> : null}
                {has('browser') ? <NavRow route="genie://browser" current={route} icon="globe" label="Browser" onNavigate={onNavigate} compact /> : null}
                {has('toolchain') ? <NavRow route="genie://toolchain" current={route} icon="wrench" label="Toolchain" onNavigate={onNavigate} compact /> : null}
                {has('inbox') ? <NavRow route="genie://inbox" current={route} icon="mail" label="AgentInbox" onNavigate={onNavigate} compact /> : null}
                {has('settings') ? <NavRow route="genie://settings" current={route} icon="settings" label="Settings" onNavigate={onNavigate} compact /> : null}
                {has('workspace') ? <div className="my-1 h-px w-6 bg-[var(--border-1)]" /> : null}
                {(has('workspace') ? shown : []).map((w) => {
                    const route_ = `genie://workspace/${w.id}`;
                    const active = current === route_;
                    const name = w.name ?? folderName(w.path);
                    return (
                        <button
                            key={w.id}
                            type="button"
                            data-nav={route_}
                            data-workspace={w.id}
                            {...(w.asleep === true ? { 'data-asleep': 'true' } : {})}
                            data-active={active ? 'true' : 'false'}
                            {...(w.alert === null ? {} : { 'data-alert': String(w.alert) })}
                            onClick={() => onNavigate(route_)}
                            title={name}
                            aria-label={name}
                            className={`${ICON_BUTTON} relative font-mono text-[11px] font-semibold uppercase ${active ? ROW_ACTIVE : ''}`}
                        >
                            {w.asleep === true ? <Icon name="moon" size="sm" /> : name.slice(0, 2)}
                            {w.alert === true ? <span aria-label="needs you" className="absolute right-1 top-1 size-1.5 rounded-full bg-[var(--warning)]" /> : null}
                        </button>
                    );
                })}
                <div className="mt-auto flex flex-col items-center gap-1">
                    {asleepTool}
                    {addTool}
                </div>
            </nav>
        );
    }

    return (
        <nav
            aria-label="Genie"
            className="flex w-52 shrink-0 flex-col gap-2 border-r border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-2.5"
        >
            {/* THE TOOLS (Genie 1's rail header, Tynn #282/#799): collapse and System; hibernated and + sit by Workspaces. */}
            <div data-rail-tools="" className="flex items-center gap-0.5">
                <button type="button" data-rail-tool="collapse" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={() => setRail(true)} className={ICON_BUTTON}>
                    <Icon name="panel-left" size="sm" />
                </button>
                {systemTool}
            </div>
            {has('deck') ? (
                <NavRow route="genie://deck" current={route} icon="inbox" label="Deck" onNavigate={onNavigate}>
                {/*
                 * The only badge in the application. Zero renders nothing — a badge that is
                 * sometimes `0` is furniture, and furniture is what people learn not to read.
                 */}
                {badge !== null ? (
                    <span
                        data-deck-badge={badge}
                        className="ml-auto rounded-sm bg-[var(--warning)]/15 px-1.5 font-mono text-[11px] tabular-nums text-[var(--warning)]"
                    >
                        {badge}
                    </span>
                ) : null}
                </NavRow>
            ) : null}

            {has('dashboard') ? (
                <NavRow
                    route="genie://dashboard"
                    current={route}
                    icon="layout-list"
                    label="Dashboard"
                    onNavigate={onNavigate}
                />
            ) : null}

            {/*
             * The OS agent — the one agent that is not in a workspace, and present on every
             * rail once the agent surface can render it.
             */}
            {has('genie') ? (
                <NavRow route="genie://agent/genie" current={route} icon="sparkles" label="genie" onNavigate={onNavigate} />
            ) : null}

            {/* Each named as its surface names itself: Sites / Processes / Services live in Hosting. */}
            {has('hosting') ? <NavRow route="genie://hosting" current={route} icon="server" label="Hosting" onNavigate={onNavigate} /> : null}
            {has('browser') ? <NavRow route="genie://browser" current={route} icon="globe" label="Browser" onNavigate={onNavigate} /> : null}
            {has('toolchain') ? <NavRow route="genie://toolchain" current={route} icon="wrench" label="Toolchain" onNavigate={onNavigate} /> : null}
            {has('inbox') ? <NavRow route="genie://inbox" current={route} icon="mail" label="AgentInbox" onNavigate={onNavigate} /> : null}

            {/* Settings, as a labelled row: the palette is an accelerator, never the only route to a surface. */}
            {has('settings') ? (
                <NavRow route="genie://settings" current={route} icon="settings" label="Settings" onNavigate={onNavigate} />
            ) : null}

            {/*
             * The whole section is gated, heading included. An orphan heading over nothing
             * reads as a list that failed to load, which is a worse lie than no heading.
             */}
            {has('workspace') ? (
                <>
                    <div className="mt-2 flex items-center px-2 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">
                        Workspaces
                        <span className="ml-auto flex items-center gap-0.5 normal-case tracking-normal">
                            {asleepTool}
                            {addTool}
                        </span>
                    </div>
                    <input
                        type="search"
                        data-rail-filter=""
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter workspaces…"
                        aria-label="Filter workspaces"
                        className="mx-1 rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 text-[12px] text-[var(--fg-1)] placeholder:text-[var(--fg-4)] focus:border-[var(--accent)] focus:outline-none"
                    />
                </>
            ) : null}

            {(has('workspace') ? shown : []).map((w) => {
                const route_ = `genie://workspace/${w.id}`;
                const active = route.split('?')[0] === route_;

                return (
                    <button
                        key={w.id}
                        type="button"
                        data-nav={route_}
                        data-workspace={w.id}
                        {...(w.asleep === true ? { 'data-asleep': 'true' } : {})}
                        // A governed workspace (§6.1) sits indented under its ops project and says whose it is.
                        {...(w.governedBy ? { 'data-governed-by': w.governedBy, style: { paddingLeft: '1.5rem' } } : {})}
                        data-active={active ? 'true' : 'false'}
                        // `alert` is tri-state and the attribute is OMITTED when it is unknown.
                        // Rendering `data-alert="false"` for an unread workspace would assert
                        // "nothing in here needs you", which is a claim about a thing Genie has
                        // not looked at.
                        {...(w.alert === null ? {} : { 'data-alert': String(w.alert) })}
                        onClick={() => onNavigate(route_)}
                        title={w.path}
                        className={`${ROW} ${active ? ROW_ACTIVE : ''}`}
                    >
                        <Icon name={w.asleep === true ? 'moon' : 'folder'} size="sm" className="shrink-0 text-[var(--fg-4)]" />
                        <span className="truncate">{w.name ?? folderName(w.path)}</span>

                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                            {w.alert === true ? (
                                <span aria-label="needs you" className="size-1.5 rounded-full bg-[var(--warning)]" />
                            ) : null}
                            {/*
                             * The count, or nothing at all. `null` is "not read yet" and must
                             * not render — first paint is skeletons, never zeros. A measured
                             * `0` does render: Genie looked, and the workspace is empty.
                             */}
                            {w.count !== null ? (
                                <span className="font-mono text-[11px] tabular-nums text-[var(--fg-4)]">{w.count}</span>
                            ) : null}
                        </span>
                    </button>
                );
            })}
        </nav>
    );
}
