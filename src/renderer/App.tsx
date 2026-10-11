import { useEffect, useState } from 'react';
import { DEFAULT_ROUTE, parseRoute } from '../core/route.js';
import { Shell } from './Shell.js';
import { TakeOverWindow } from './components/TakeOverWindow.js';
import type { DockPanel } from '../core/dock.js';
import { pinPanel } from '../core/dock.js';
import { EMPTY_SNAPSHOT, NO_FEATURES, NO_TERMINALS, NO_UPDATES, SERVABLE, type AgentDetail, type GenieBridge, type GenieSnapshot } from './bridge.js';
import { EMPTY_FEATURES, type FeatureData } from './features.js';
import type { ChatThread } from './components/ChatFlyout.js';

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
 *
 * ## Which surfaces exist
 *
 * `SERVABLE` lives in `bridge.ts` because the rail's rows are DERIVED from it. Two lists would
 * drift, and the failure is silent in both directions: a row that navigates to a surface the
 * shell cannot render, or a surface that renders with nothing pointing at it — which is §0.4
 * again. **Add a surface in the commit that makes it render, never before.**
 */

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

function useFeatures(bridge: GenieBridge | undefined): [FeatureData, (data: FeatureData) => void] {
    const [data, setData] = useState<FeatureData>(EMPTY_FEATURES);
    useEffect(() => {
        const features = bridge?.features ?? NO_FEATURES;
        let live = true;
        void features.snapshot().then((d) => { if (live) setData(d); });
        const off = features.subscribe((d) => { if (live) setData(d); });
        return () => { live = false; off(); };
    }, [bridge]);
    return [data, setData];
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

/**
 * One agent's detail, with `resolved` reported separately.
 *
 * `detail === null` is **two different states** — "we have not asked yet" and "no such agent"
 * — and the Shell renders a not-found for the second. Merging them would flash an error on
 * every navigation to a perfectly good agent while its detail loaded.
 */
function useAgentDetail(
    bridge: GenieBridge | undefined,
    agentId: string | null,
): { detail: AgentDetail | null; resolved: boolean } {
    const [state, setState] = useState<{ detail: AgentDetail | null; resolved: boolean }>({
        detail: null,
        resolved: false,
    });

    useEffect(() => {
        if (!bridge || agentId === null) {
            setState({ detail: null, resolved: false });
            return;
        }

        let live = true;
        // Reset on the way in, so navigating between agents cannot show the previous one's
        // ledger under the new one's name for a frame.
        setState({ detail: null, resolved: false });

        void bridge.agentDetail(agentId).then((detail) => {
            if (live) setState({ detail, resolved: true });
        });
        const off = bridge.subscribeAgent(agentId, (detail) => {
            if (live) setState({ detail, resolved: true });
        });

        return () => { live = false; off(); };
    }, [bridge, agentId]);

    return state;
}

export interface AppProps {
    /** Injected by tests and by the live check. The real app reads `window.genie`. */
    bridge?: GenieBridge | undefined;
}

export function App({ bridge }: AppProps) {
    const [route, navigate] = useRoute();
    const resolvedBridge = bridge ?? (typeof window === 'undefined' ? undefined : window.genie);
    const snapshot = useSnapshot(resolvedBridge);
    const [features, setFeatures] = useFeatures(resolvedBridge);

    const parsed = parseRoute(route);
    const agentId = parsed.surface === 'agent' ? parsed.agentId : null;
    const { detail, resolved } = useAgentDetail(resolvedBridge, agentId);

    // The selected stream row — the Inspector's subject. Deliberately NOT in the URL: the
    // design says the Inspector is closed on arrival and does not remember being open across
    // agents, so it is view state rather than a place you can be sent to. (`?at=` is the
    // shareable anchor, and it scrolls rather than selects.)
    const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
    useEffect(() => { setSelectedRowId(null); }, [agentId]);

    /**
     * Which panel holds the single dock slot.
     *
     * View state, not route state, and deliberately: `?pin=right` in the route says a panel IS
     * pinned, and this says WHICH — but at most one can be, so the route's `chat=<agent>` plus
     * `pin=right` already describes a pinned chat completely. Keeping a second copy of "which
     * panel" in the URL would let the two disagree.
     */
    const [pinned, setPinned] = useState<DockPanel | null>(parsed.pin === 'right' ? 'chat' : null);

    /**
     * The option id currently in flight, so the buttons refuse a second press.
     *
     * Cleared when the agent's detail changes — which is when the main process has pushed the
     * answered state back. Clearing it on a timer would guess at when the provider replied.
     */
    const [answering, setAnswering] = useState<string | null>(null);

    /**
     * The chat subject comes from the ROUTE, so a link can open a conversation — and so a
     * pinned chat's subject does not follow the view when you navigate elsewhere.
     */
    const chatSubject = parsed.chat;
    const chatThread: ChatThread | null =
        chatSubject === null
            ? null
            : {
                  agentId: chatSubject,
                  name: snapshot.agents.find((a) => a.id === chatSubject)?.name ?? chatSubject,
                  fidelity: snapshot.agents.find((a) => a.id === chatSubject)?.fidelity ?? 'declared',
                  // `null`, not `0`: nothing has read this thread's unread count yet, and a
                  // zero would claim you are up to date. AgentInbox lands with P4.
                  unread: null,
                  messages: [],
              };

    // A route this build cannot serve goes home rather than leaving a blank body under a
    // stale address — the one state a person cannot get out of without knowing a shortcut.
    // It happens in practice: a hash left over from a previous version survives an upgrade.
    const surface = parsed.surface;
    useEffect(() => {
        if (!SERVABLE.includes(surface)) window.location.replace(`#${DEFAULT_ROUTE}`);
    }, [surface]);

    // A TAKE OVER WINDOW renders the terminal and nothing else: no rail, no bar, no Deck. The
    // TUI is the window (§1).
    if (parsed.surface === 'takeover') {
        return <TakeOverWindow terminalId={parsed.terminalId} terminals={resolvedBridge?.terminals ?? NO_TERMINALS} />;
    }

    return (
        <Shell
            route={route}
            snapshot={snapshot}
            servable={SERVABLE}
            agentDetail={detail}
            agentResolved={resolved}
            selectedRowId={selectedRowId}
            chatThread={chatThread}
            pinned={pinned}
            onNavigate={navigate}
            features={features}
            onFeature={(action) => {
                void (resolvedBridge?.features ?? NO_FEATURES).act(action).then(setFeatures).catch((error: unknown) => {
                    // A refusal is a fact the surface shows; it is never swallowed. Until the surfaces
                    // carry an error line, the console is where it lands.
                    console.error('[genie] feature action refused:', (error as Error).message);
                });
            }}
            onSend={(id, text) => { if (id) resolvedBridge?.prompt(id, text); }}
            answeringApproval={answering}
            onAnswerApproval={(optionId) => {
                if (!agentId) return;
                setAnswering(optionId);
                resolvedBridge?.answerApproval(agentId, optionId);
            }}
            onAnswerDeckItem={(id, optionId) => {
                // The Deck answers for an agent the route is NOT on, so the id comes from the
                // item rather than from the URL.
                setAnswering(optionId);
                resolvedBridge?.answerApproval(id, optionId);
            }}
            onTogglePin={() => {
                // The single slot's rule lives in `core/dock.ts`, including the file panel's
                // refusal. No file panel exists until P5, so `false` is the honest argument
                // today rather than a placeholder that would silently become wrong.
                const outcome = pinPanel(pinned, 'chat', false);
                if (outcome.refused === null) setPinned(outcome.pinned);
            }}
            onCloseChat={() => {
                // `Esc` and the close button drop the chat from the ROUTE, which is the one
                // place its subject lives. A pinned dock has no close button and Esc does not
                // close it — that is enforced in the component, not here.
                const next = route.replace(/[?&]chat=[^&]*/, '').replace(/[?&]pin=[^&]*/, '');
                navigate(next);
            }}
            onOpenAgent={(id) => {
                // Start or reattach, THEN navigate. Reattach is the main process's job and is
                // idempotent, so arriving at an agent that is already running is not a second
                // session — §6.2 is explicit, and the alternative is two provider processes
                // answering as one agent.
                resolvedBridge?.openAgent(id);
                navigate(`genie://agent/${id}?tab=stream`);
            }}
            onAddAgent={(workspaceId) => resolvedBridge?.addAgent(workspaceId)}
            onAddWorkspace={() => resolvedBridge?.addWorkspace()}
            terminals={resolvedBridge?.terminals ?? NO_TERMINALS}
            updates={resolvedBridge?.updates ?? NO_UPDATES}
            onTakeOver={(agentId) => { void resolvedBridge?.takeOver(agentId); }}
            onSelectRow={setSelectedRowId}
            onOpenPalette={() => {
                // Fancy's `Command` lands with the Deck in P4. The box stays in the bar because
                // it is part of the bar's geometry and its label is honest about what it will
                // do — but it opens nothing rather than opening an empty palette, which would
                // teach someone that search does not work here.
            }}
        />
    );
}
