import { useEffect, useState } from 'react';
import { DEFAULT_ROUTE, parseRoute } from '../core/route.js';
import { Shell } from './Shell.js';
import type { RailSurface } from './components/Sidebar.js';
import { EMPTY_SNAPSHOT, type GenieBridge, type GenieSnapshot } from './bridge.js';

/**
 * THE APP — the effects, and nothing else.
 *
 * `Shell` renders; this wires it to the hash and to the bridge. Everything testable lives in
 * `Shell`, which is why this file is short enough to read in one go.
 *
 * ## The route lives in the hash
 *
 * `location.hash` carries `genie://…` verbatim, which buys the back button, refresh and deep
 * links with no router. Navigation writes the hash; the hash writes the view. **Nothing holds
 * a second copy of "where am I"** — two copies is how a rail highlights one surface while the
 * body shows another.
 */

/**
 * What this build can actually show.
 *
 * Grows one entry per phase, **in the commit that makes the surface render.** P2 is the
 * Dashboard; `deck`, `genie` (the agent surface) and `workspace` arrive with P4, P3 and P5.
 */
const AVAILABLE: readonly RailSurface[] = ['dashboard'];

function useRoute(): [string, (route: string) => void] {
    const [route, setRoute] = useState<string>(() =>
        typeof window === 'undefined' ? DEFAULT_ROUTE : window.location.hash.slice(1) || DEFAULT_ROUTE,
    );

    useEffect(() => {
        const onHash = () => setRoute(window.location.hash.slice(1) || DEFAULT_ROUTE);
        window.addEventListener('hashchange', onHash);
        // Seed the address on first load so the bar and the view agree from the first paint.
        if (!window.location.hash) window.location.replace(`#${DEFAULT_ROUTE}`);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);

    // Assigning the hash pushes a history entry, which is what makes Back work. Deliberately
    // not `replace`: a navigation a person made is a place they can come back from.
    return [route, (next: string) => { window.location.hash = next; }];
}

function useSnapshot(bridge: GenieBridge | undefined): GenieSnapshot {
    const [snapshot, setSnapshot] = useState<GenieSnapshot>(EMPTY_SNAPSHOT);

    useEffect(() => {
        if (!bridge) return;
        let live = true;

        // One read to start from, then PUSH. No interval anywhere: a polled dashboard is wrong
        // for up to its interval, and with thirty agents it re-reads the registry a hundred
        // times a minute to learn nothing.
        void bridge.snapshot().then((s) => { if (live) setSnapshot(s); });
        const off = bridge.subscribe((s) => { if (live) setSnapshot(s); });

        return () => { live = false; off(); };
    }, [bridge]);

    return snapshot;
}

export interface AppProps {
    /** Injected by tests and by the live check. The real app reads `window.genie`. */
    bridge?: GenieBridge | undefined;
}

export function App({ bridge }: AppProps) {
    const [route, navigate] = useRoute();
    const resolved = bridge ?? (typeof window === 'undefined' ? undefined : window.genie);
    const snapshot = useSnapshot(resolved);

    // A route this build cannot serve goes home rather than leaving a blank body under a
    // stale address — the one state a person cannot get out of without knowing a shortcut.
    // It happens in practice: a hash left over from a previous version survives an upgrade.
    const surface = parseRoute(route).surface;
    useEffect(() => {
        if (!AVAILABLE.includes(surface as RailSurface)) window.location.replace(`#${DEFAULT_ROUTE}`);
    }, [surface]);

    return (
        <Shell
            route={route}
            snapshot={snapshot}
            available={AVAILABLE}
            onNavigate={navigate}
            onOpenAgent={(id) => resolved?.openAgent(id)}
            onAddAgent={(workspaceId) => resolved?.addAgent(workspaceId)}
            onOpenPalette={() => {
                // Fancy's `Command` lands with the Deck in P4. The box stays in the bar because
                // it is part of the bar's geometry and its label is honest about what it will
                // do — but it opens nothing rather than opening an empty palette, which would
                // teach someone that search does not work here.
            }}
        />
    );
}
