import { parseRoute } from '../core/route.js';
import { railSurfacesFor, railWorkspaces, type Surface } from '../core/rail-view.js';
import { AgentView } from './components/AgentView.js';
import { Dashboard } from './components/Dashboard.js';
import { Sidebar } from './components/Sidebar.js';
import { TitleBar } from './components/TitleBar.js';
import type { AgentDetail, GenieSnapshot } from './bridge.js';

/**
 * THE SHELL — chrome, route, surface, and **no effects**.
 *
 * Everything here is a function of `(route, snapshot)`. The hash listener, the bridge
 * subscription and the redirect all live in `App`, one layer out.
 *
 * That split is not tidiness. A shell that owns its own data loading can only be rendered by
 * launching Electron, so the only way to look at it is to open the app — and nobody opened
 * the app for four releases. This one renders from a plain object, which means the surfaces
 * can be asserted on, with real agents in them, in a test that runs on CI.
 *
 * ## Which surfaces the rail offers
 *
 * `available` is the honest list of what this build can render; the rail **omits** the rest
 * rather than disabling it. Each phase has to leave the app usable, and a rail offering a
 * route the shell cannot serve is the previous attempt's "built and unreachable" with the
 * arrow reversed.
 *
 * **Add a surface to that list in the same commit that makes it render, never before.**
 */

export interface ShellProps {
    route: string;
    snapshot: GenieSnapshot;
    /** Which surfaces this build renders. The rail's rows are DERIVED from it, not parallel. */
    servable: readonly Surface[];
    /** The agent the route names, when it names one. `null` while loading or if unknown. */
    agentDetail: AgentDetail | null;
    /** Whether `agentDetail` has been looked up yet — `null` alone cannot say. */
    agentResolved: boolean;
    selectedRowId: string | null;
    onNavigate: (route: string) => void;
    onOpenAgent: (agentId: string) => void;
    onAddAgent: (workspaceId: string) => void;
    onOpenPalette: () => void;
    onSelectRow: (rowId: string | null) => void;
}

export function Shell({
    route,
    snapshot,
    servable,
    agentDetail,
    agentResolved,
    selectedRowId,
    onNavigate,
    onOpenAgent,
    onAddAgent,
    onOpenPalette,
    onSelectRow,
}: ShellProps) {
    const parsed = parseRoute(route);
    const canServe = servable.includes(parsed.surface);

    return (
        <div className="flex h-full flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <TitleBar
                route={route}
                workstation={snapshot.workstation}
                onNavigate={onNavigate}
                onOpenPalette={onOpenPalette}
            />

            <div className="flex min-h-0 flex-1">
                <Sidebar
                    route={route}
                    deckCount={snapshot.deckCount}
                    workspaces={railWorkspaces(snapshot.workspaces, snapshot.agents)}
                    available={railSurfacesFor(servable)}
                    onNavigate={onNavigate}
                />

                <main className="min-w-0 flex-1 overflow-auto">
                    {/*
                     * A route this build cannot serve renders NOTHING here, and `App` redirects
                     * it. The alternative — a surface frame with an empty body — is the one
                     * state a person cannot recover from without knowing a shortcut, and it is
                     * indistinguishable from a load that failed.
                     */}
                    {canServe && parsed.surface === 'dashboard' ? (
                        <Dashboard
                            rows={snapshot.agents}
                            workspaces={snapshot.workspaces}
                            onOpenAgent={onOpenAgent}
                            onAddAgent={onAddAgent}
                        />
                    ) : null}

                    {canServe && parsed.surface === 'agent' && agentDetail ? (
                        <AgentView
                            agent={agentDetail.agent}
                            session={agentDetail.session}
                            rows={agentDetail.rows}
                            tab={parsed.tab}
                            lanes={null}
                            at={parsed.at}
                            selectedId={selectedRowId}
                            turns={agentDetail.turns}
                            cost={agentDetail.cost}
                            onNavigate={onNavigate}
                            onSelect={onSelectRow}
                        />
                    ) : null}

                    {/*
                     * An agent id that is not registered. **Only once the lookup has actually
                     * happened** — `agentDetail === null` is both "not found" and "not asked
                     * yet", and rendering a not-found during the load would flash an error on
                     * every navigation to a perfectly good agent.
                     *
                     * It says what is wrong and offers the way back. A blank body under a
                     * stale address is the one state a person cannot recover from without
                     * knowing a shortcut.
                     */}
                    {canServe && parsed.surface === 'agent' && agentResolved && !agentDetail ? (
                        <div data-surface="agent-unknown" className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-[var(--fg-3)]">
                            <p>
                                No agent is registered as{' '}
                                <span className="font-mono text-[var(--fg-2)]">{parsed.agentId}</span>.
                            </p>
                            <button
                                type="button"
                                data-nav="genie://dashboard"
                                onClick={() => onNavigate('genie://dashboard')}
                                className="rounded-md border border-[var(--border-1)] px-2.5 py-1 text-xs hover:bg-[var(--bg-2)]"
                            >
                                Back to the Dashboard
                            </button>
                        </div>
                    ) : null}
                </main>
            </div>
        </div>
    );
}
