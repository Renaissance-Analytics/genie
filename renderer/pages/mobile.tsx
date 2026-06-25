import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Action, Icon, Text } from '@particle-academy/react-fancy';
import PairScreen from '../components/Mobile/PairScreen';
import Dashboard from '../components/Mobile/Dashboard';
import Questions from '../components/Mobile/Questions';
import MobileTerminalView from '../components/Mobile/Terminal';
import {
    clearToken,
    connectEvents,
    createTerminal,
    getState,
    getToken,
    killTerminal,
    listTerminals,
    MobileApiError,
    onNeedsPair,
    type MobileEvent,
    type MobileState,
    type MobileTerminal,
} from '../lib/mobile-client';

/**
 * Genie Mobile — the phone-facing remote-control shell. Builds to
 * `app/mobile.html` (mirrors `pages/terminal.tsx` so Nextron emits the page);
 * the tailnet server serves it under `/m/`. This page runs in a PLAIN browser
 * over Tailscale with NO Electron preload bridge, so it NEVER calls `api()` —
 * all data flows through `lib/mobile-client.ts` (`fetch` + `WebSocket`).
 *
 * Shell responsibilities:
 *   - No token → PairScreen (auto-fills `?pair=`).
 *   - Token → bootstrap `GET /api/state`, open ONE shared `/ws/events` socket,
 *     and fan its events out to every tab via a `subscribe()` registry (so the
 *     dashboard / questions / terminal-list all live-update off one connection).
 *   - Bottom-nav Dashboard / Questions / Terminal, with a questions badge.
 *   - needs-pair (401 anywhere) → back to Pair; reconnecting + locked banners.
 */

type Tab = 'dashboard' | 'questions' | 'terminal';

export default function MobilePage() {
    const [token, setTokenState] = useState<string | null>(null);
    const [booted, setBooted] = useState(false);
    const [state, setState] = useState<MobileState | null>(null);
    const [bootError, setBootError] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>('dashboard');
    const [questionCount, setQuestionCount] = useState(0);
    const [locked, setLocked] = useState(false);
    const [connected, setConnected] = useState(false);

    // The shared /ws/events subscriber registry. Tabs register a callback; the
    // single socket below fans every event out to all of them. A ref keeps the
    // set stable across renders so subscribing doesn't churn the socket.
    const subscribersRef = useRef<Set<(e: MobileEvent) => void>>(new Set());
    const subscribe = useCallback((cb: (e: MobileEvent) => void) => {
        subscribersRef.current.add(cb);
        return () => {
            subscribersRef.current.delete(cb);
        };
    }, []);

    // Resolve the token on mount (localStorage is only available client-side).
    useEffect(() => {
        setTokenState(getToken());
    }, []);

    // needs-pair: a 401 from any authed call clears the token + fires this. Drop
    // every authed surface back to Pair.
    useEffect(() => {
        return onNeedsPair(() => {
            setTokenState(null);
            setBooted(false);
            setState(null);
            setConnected(false);
        });
    }, []);

    // Bootstrap once we have a token: pull /api/state, then open /ws/events.
    useEffect(() => {
        if (!token) return;
        let cancelled = false;

        void (async () => {
            try {
                const snapshot = await getState();
                if (cancelled) return;
                setState(snapshot);
                setQuestionCount(snapshot.questions.length);
                setBootError(null);
                setBooted(true);
            } catch (e) {
                if (cancelled) return;
                // 401 already routed to needs-pair; show anything else as a
                // bootstrap failure with a retry.
                if (e instanceof MobileApiError && e.isUnauthorized) return;
                setBootError(
                    e instanceof MobileApiError && e.status === 0
                        ? "Can't reach Genie. Check Tailscale and that Genie is running."
                        : e instanceof Error
                          ? e.message
                          : 'Failed to load',
                );
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [token]);

    // Open the single shared events socket once booted. Fan every push out to
    // the tab subscribers; track connected state for the reconnecting banner.
    useEffect(() => {
        if (!token || !booted) return;
        setConnected(true);
        const conn = connectEvents((e) => {
            for (const cb of subscribersRef.current) {
                try {
                    cb(e);
                } catch {
                    /* a bad subscriber must not stop the others */
                }
            }
        });
        return () => {
            conn.close();
            setConnected(false);
        };
    }, [token, booted]);

    const onPaired = () => {
        setTokenState(getToken());
    };

    const signOut = () => {
        clearToken();
        setTokenState(null);
        setBooted(false);
        setState(null);
    };

    // ---- render gates ----

    if (!token) {
        return <PairScreen onPaired={onPaired} />;
    }

    if (bootError && !state) {
        return (
            <div className="m-app m-center">
                <Icon name="alert-triangle" size="lg" className="text-amber-500" />
                <Text size="sm" className="text-zinc-500" style={{ textAlign: 'center' }}>
                    {bootError}
                </Text>
                <div className="m-center-actions">
                    <Action
                        color="blue"
                        icon="refresh-cw"
                        onClick={() => setTokenState((t) => (t ? `${t}` : t))}
                    >
                        Retry
                    </Action>
                    <Action variant="ghost" icon="log-out" onClick={signOut}>
                        Re-pair
                    </Action>
                </div>
            </div>
        );
    }

    if (!booted || !state) {
        return (
            <div className="m-app m-center">
                <Icon name="loader" size="lg" className="m-spin text-violet-500" />
                <Text size="sm" className="text-zinc-500">
                    Connecting to Genie…
                </Text>
            </div>
        );
    }

    return (
        <div className="m-app">
            {!connected && (
                <div className="m-banner m-banner-warn">
                    <Icon name="wifi-off" size="xs" />
                    <Text size="xs">Reconnecting…</Text>
                </div>
            )}
            {locked && (
                <div className="m-banner m-banner-lock">
                    <Icon name="lock" size="xs" />
                    <Text size="xs">Locked on desktop — actions are disabled.</Text>
                </div>
            )}

            <div className="m-body">
                {tab === 'dashboard' && (
                    <Dashboard
                        state={state}
                        subscribe={subscribe}
                        onLocked={() => setLocked(true)}
                    />
                )}
                {tab === 'questions' && (
                    <Questions
                        initial={state.questions}
                        subscribe={subscribe}
                        onCountChange={setQuestionCount}
                    />
                )}
                {tab === 'terminal' && (
                    <TerminalTab
                        state={state}
                        subscribe={subscribe}
                        onLocked={() => setLocked(true)}
                    />
                )}
            </div>

            <nav className="m-nav">
                <NavButton
                    icon="layout-grid"
                    label="Dashboard"
                    active={tab === 'dashboard'}
                    onClick={() => setTab('dashboard')}
                />
                <NavButton
                    icon="message-circle"
                    label="Questions"
                    active={tab === 'questions'}
                    badge={questionCount}
                    onClick={() => setTab('questions')}
                />
                <NavButton
                    icon="terminal"
                    label="Terminal"
                    active={tab === 'terminal'}
                    onClick={() => setTab('terminal')}
                />
            </nav>
        </div>
    );
}

function NavButton({
    icon,
    label,
    active,
    badge,
    onClick,
}: {
    icon: string;
    label: string;
    active: boolean;
    badge?: number;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            className={`m-nav-btn${active ? ' active' : ''}`}
            onClick={onClick}
        >
            <span className="m-nav-icon">
                <Icon name={icon} size="sm" />
                {badge != null && badge > 0 && (
                    <span className="m-nav-badge">{badge > 99 ? '99+' : badge}</span>
                )}
            </span>
            <span className="m-nav-label">{label}</span>
        </button>
    );
}

/**
 * The Terminal tab: pick a terminal to view (or create a fresh one in a
 * workspace), then mount the thin xterm viewer against it. Keeps the terminal
 * list live off `terminal-spec:changed`. A create returns a new id we switch to
 * immediately; kill drops it and returns to the picker.
 */
function TerminalTab({
    state,
    subscribe,
    onLocked,
}: {
    state: MobileState;
    subscribe: (cb: (e: MobileEvent) => void) => () => void;
    onLocked: () => void;
}) {
    const [terminals, setTerminals] = useState<MobileTerminal[]>(state.terminals);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [creatingIn, setCreatingIn] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const active = useMemo(
        () => terminals.find((t) => t.id === activeId) ?? null,
        [terminals, activeId],
    );

    const refetch = () =>
        listTerminals()
            .then(setTerminals)
            .catch(() => {});

    useEffect(() => {
        const off = subscribe((e: MobileEvent) => {
            if (e.type === 'terminal-spec:changed') void refetch();
        });
        return off;
    }, [subscribe]);

    const create = async (workspaceId: string) => {
        setCreatingIn(workspaceId);
        setError(null);
        try {
            const { id } = await createTerminal({ workspaceId });
            await refetch();
            setActiveId(id);
        } catch (e) {
            if (e instanceof MobileApiError && e.isLocked) onLocked();
            else setError(e instanceof Error ? e.message : 'Failed to create terminal');
        } finally {
            setCreatingIn(null);
        }
    };

    const kill = async (id: string) => {
        try {
            await killTerminal(id);
        } catch (e) {
            if (e instanceof MobileApiError && e.isLocked) {
                onLocked();
                return;
            }
        }
        if (activeId === id) setActiveId(null);
        void refetch();
    };

    if (active) {
        return (
            <div className="m-term-wrap">
                <div className="m-term-head">
                    <Action
                        size="sm"
                        variant="ghost"
                        icon="chevron-left"
                        onClick={() => setActiveId(null)}
                    >
                        Terminals
                    </Action>
                    <div style={{ flex: 1 }} />
                    <Action
                        size="sm"
                        variant="ghost"
                        color="rose"
                        icon="trash-2"
                        onClick={() => void kill(active.id)}
                        aria-label="Kill terminal"
                    />
                </div>
                <MobileTerminalView terminal={active} />
            </div>
        );
    }

    return (
        <div className="m-scroll">
            {error && (
                <div className="m-pair-error">
                    <Icon name="alert-triangle" size="xs" />
                    <Text size="xs">{error}</Text>
                </div>
            )}

            <section className="m-section">
                <div className="m-section-head">
                    <Icon name="terminal" size="xs" />
                    <Text size="xs" className="m-section-title">
                        Open terminals
                    </Text>
                </div>
                {terminals.length === 0 ? (
                    <Text size="sm" className="text-zinc-500 m-empty">
                        No terminals. Create one below.
                    </Text>
                ) : (
                    <div className="m-list">
                        {terminals.map((t) => (
                            <button
                                key={t.id}
                                type="button"
                                className="m-card m-term-row"
                                onClick={() => setActiveId(t.id)}
                            >
                                <span
                                    className="m-dot"
                                    style={{
                                        background: t.running
                                            ? 'var(--emerald-500)'
                                            : 'var(--fg-4)',
                                    }}
                                />
                                <div className="m-term-row-main">
                                    <Text size="sm" style={{ fontWeight: 600 }}>
                                        {t.label}
                                    </Text>
                                    <Text size="xs" className="text-zinc-500 m-mono m-truncate">
                                        {t.cwd}
                                    </Text>
                                </div>
                                <Icon name="chevron-right" size="xs" />
                            </button>
                        ))}
                    </div>
                )}
            </section>

            <section className="m-section">
                <div className="m-section-head">
                    <Icon name="plus" size="xs" />
                    <Text size="xs" className="m-section-title">
                        New terminal in…
                    </Text>
                </div>
                <div className="m-list">
                    {state.workspaces.map((ws) => (
                        <button
                            key={ws.id}
                            type="button"
                            className="m-card m-term-row"
                            disabled={creatingIn != null}
                            onClick={() => void create(ws.id)}
                        >
                            <div className="m-term-row-main">
                                <Text size="sm" style={{ fontWeight: 600 }}>
                                    {ws.name}
                                </Text>
                            </div>
                            {creatingIn === ws.id ? (
                                <Icon name="loader" size="xs" className="m-spin" />
                            ) : (
                                <Icon name="plus" size="xs" />
                            )}
                        </button>
                    ))}
                </div>
            </section>
        </div>
    );
}
