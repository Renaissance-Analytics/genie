import { parseRoute } from '../core/route.js';
import { railWorkspaces } from '../core/rail-view.js';
import { Dashboard } from './components/Dashboard.js';
import { Sidebar, type RailSurface } from './components/Sidebar.js';
import { TitleBar } from './components/TitleBar.js';
import type { GenieSnapshot } from './bridge.js';

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
    available: readonly RailSurface[];
    onNavigate: (route: string) => void;
    onOpenAgent: (agentId: string) => void;
    onAddAgent: (workspaceId: string) => void;
    onOpenPalette: () => void;
}

export function Shell({
    route,
    snapshot,
    available,
    onNavigate,
    onOpenAgent,
    onAddAgent,
    onOpenPalette,
}: ShellProps) {
    const parsed = parseRoute(route);
    const servable = available.includes(parsed.surface as RailSurface);

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
                    available={available}
                    onNavigate={onNavigate}
                />

                <main className="min-w-0 flex-1 overflow-auto">
                    {/*
                     * A route this build cannot serve renders NOTHING here, and `App` redirects
                     * it. The alternative — a surface frame with an empty body — is the one
                     * state a person cannot recover from without knowing a shortcut, and it is
                     * indistinguishable from a load that failed.
                     */}
                    {servable && parsed.surface === 'dashboard' ? (
                        <Dashboard
                            rows={snapshot.agents}
                            workspaces={snapshot.workspaces}
                            onOpenAgent={onOpenAgent}
                            onAddAgent={onAddAgent}
                        />
                    ) : null}
                </main>
            </div>
        </div>
    );
}
