import { Icon } from '@particle-academy/react-fancy';
import { deckBadge, type RailItem, type RailSurface } from '../../core/rail-view.js';
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
}: {
    route: string;
    current: string;
    icon: string;
    label: string;
    onNavigate: (route: string) => void;
    children?: React.ReactNode;
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
            className={`${ROW} ${active ? ROW_ACTIVE : ''}`}
        >
            <Icon name={icon} size="sm" className="shrink-0 text-[var(--fg-4)]" />
            <span className="truncate">{label}</span>
            {children}
        </button>
    );
}

export function Sidebar({ route, deckCount, workspaces, available, onNavigate }: SidebarProps) {
    const has = (s: RailSurface): boolean => available.includes(s);
    // No orphan badge: the Deck's count has nowhere to live without the Deck.
    const badge = has('deck') ? deckBadge(deckCount) : null;

    return (
        <nav
            aria-label="Genie"
            className="flex w-52 shrink-0 flex-col gap-2 border-r border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-2.5"
        >
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

            {/* Settings, as a labelled row: the palette is an accelerator, never the only route to a surface. */}
            {has('settings') ? (
                <NavRow route="genie://settings" current={route} icon="settings" label="Settings" onNavigate={onNavigate} />
            ) : null}

            {/*
             * The whole section is gated, heading included. An orphan heading over nothing
             * reads as a list that failed to load, which is a worse lie than no heading.
             */}
            {has('workspace') ? (
                <div className="mt-2 px-2 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">
                    Workspaces
                </div>
            ) : null}

            {(has('workspace') ? workspaces : []).map((w) => {
                const route_ = `genie://workspace/${w.id}`;
                const active = route.split('?')[0] === route_;

                return (
                    <button
                        key={w.id}
                        type="button"
                        data-nav={route_}
                        data-workspace={w.id}
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
                        <Icon name="folder" size="sm" className="shrink-0 text-[var(--fg-4)]" />
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
