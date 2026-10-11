import { useEffect, useRef, useState } from 'react';
import { DEFAULT_ROUTE, parseRoute } from '../core/route.js';
import { Shell } from './Shell.js';
import { TakeOverWindow } from './components/TakeOverWindow.js';
import type { DockPanel } from '../core/dock.js';
import { pinPanel } from '../core/dock.js';
import { globalAction, isTypingTarget } from '../core/keys.js';
import { EMPTY_SNAPSHOT, NO_FEATURES, NO_TERMINALS, NO_UPDATES, SERVABLE, type AgentDetail, type GenieBridge, type GenieSnapshot } from './bridge.js';
import { EMPTY_FEATURES, type FeatureData } from './features.js';
import { deckAnswerRoute } from '../core/deck-resolve.js';
import { alertsBetween, type AlertSnapshot } from '../core/alert-diff.js';
import { soundFor, toastFor } from '../core/alerts.js';
import { connectRemote, type RemoteClient, type RemoteState } from './remote-bridge.js';
import { remoteUrl, rememberedTokens } from './remote-session.js';
import { webSocketTransport } from './ws-transport.js';
import type { ChatThread } from './components/ChatFlyout.js';
import type { AgentOpsProps } from './components/AgentView.js';
import type { WorkspaceOpsProps } from './components/Workspace.js';
import type { AddPreviewView } from './components/AddWorkspacePreview.js';
import type { DeletePlan } from '../core/agent-ops.js';
import type { Diagnosis } from '../core/workspace-model.js';
import type { RepoEntry } from '../core/repo-registry.js';

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

/**
 * DRIVING ANOTHER MACHINE (§6.8). One client at a time; its bridge replaces the local one while
 * connected; the token a PIN pairing mints is remembered per host in this device's own storage.
 */
function useRemote(): { client: RemoteClient | null; state: RemoteState | null; remembered: string[]; connect: (input: { host: string; pin: string; label: string }) => void; disconnect: () => void } {
    const [client, setClient] = useState<RemoteClient | null>(null);
    const [state, setState] = useState<RemoteState | null>(null);
    const tokens = typeof window === 'undefined' ? null : rememberedTokens(window.localStorage);
    const [remembered, setRemembered] = useState<string[]>(() => tokens?.hosts() ?? []);

    useEffect(() => {
        if (!client) return;
        const off = client.onState((s) => {
            setState(s);
            if (s.connected && s.token && s.host && tokens) {
                // The URL is the key; the welcome carries the host's name, the hello went to the URL.
                setRemembered(tokens.hosts());
            }
        });
        return off;
    }, [client, tokens]);

    return {
        client,
        state,
        remembered,
        connect: ({ host, pin, label }) => {
            const url = remoteUrl(host);
            if (!url.ok) { setState((s) => ({ ...(s ?? EMPTY_REMOTE), lastRefusal: url.reason })); return; }
            client?.close();
            const token = tokens?.tokenFor(url.url) ?? null;
            const auth = pin.trim() ? { kind: 'pin' as const, code: pin.trim(), label } : token ? { kind: 'token' as const, token, label } : null;
            if (!auth) { setState((s) => ({ ...(s ?? EMPTY_REMOTE), lastRefusal: 'type the PIN shown on that machine — this device has not paired with it yet' })); return; }
            const next = connectRemote(webSocketTransport(url.url), auth, label || 'another screen');
            setClient(next);
            setState(next.state());
            void next.ready.then((r) => {
                if (r.ok) { const t = next.state().token; if (t && tokens) { tokens.remember(url.url, t); setRemembered(tokens.hosts()); } }
                else setState((s) => ({ ...(s ?? EMPTY_REMOTE), lastRefusal: r.reason }));
            });
        },
        disconnect: () => { client?.close(); setClient(null); setState(null); },
    };
}

const EMPTY_REMOTE: RemoteState = { connected: false, host: null, isOwner: false, workspaceId: null, driver: null, driving: false, locked: false, lastRefusal: null, token: null };

/**
 * ALERTS (§6.3) — derived from consecutive snapshots, never a timer: a new question, approval,
 * finish or mail item, or an agent that turned broken, plays its registered sound (if that row and
 * the master switch are on) and raises a toast naming the WORKSPACE and the AGENT. The first
 * snapshot after boot alerts nobody.
 */
function useAlerts(snapshot: GenieSnapshot, settings: Readonly<Record<string, boolean | string>> | null): void {
    const prev = useRef<AlertSnapshot | null>(null);
    useEffect(() => {
        const next: AlertSnapshot = { deckItems: snapshot.deckItems, agents: snapshot.agents.map((a) => ({ id: a.id, name: a.name, workspaceId: a.workspaceId, state: a.state, reason: a.reason })) };
        if (snapshot.deckItems !== null) {
            for (const alert of alertsBetween(prev.current, next)) {
                const sound = soundFor(alert.kind, settings ?? {});
                if (sound && typeof Audio !== 'undefined') {
                    const audio = new Audio(new URL(`./sounds/${sound}`, import.meta.url).href);
                    void audio.play().catch(() => { /* autoplay refused: the toast still says it */ });
                }
                if (typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
                    const toast = toastFor(alert);
                    try { new Notification(toast.title, { body: toast.body }); } catch { /* no notification surface here */ }
                }
            }
            prev.current = next;
        }
    }, [snapshot, settings]);
}

export interface AppProps {
    /** Injected by tests and by the live check. The real app reads `window.genie`. */
    bridge?: GenieBridge | undefined;
}

export function App({ bridge }: AppProps) {
    const [route, navigate] = useRoute();
    const remote = useRemote();
    const resolvedBridge = remote.state?.connected ? remote.client!.bridge : (bridge ?? (typeof window === 'undefined' ? undefined : window.genie));
    const snapshot = useSnapshot(resolvedBridge);
    const [features, setFeatures] = useFeatures(resolvedBridge);
    useAlerts(snapshot, features.settings.values);

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
     * AGENT OPERATIONS (§6.2) — view state for the Agent view's controls: a delete previewed and
     * awaiting confirmation, the last diagnosis, the last outcome (a refusal most of all). Reset on
     * the way to another agent so one agent's plan can never be confirmed on the next.
     */
    /**
     * WORKSPACE OPERATIONS (§6.1): adding is preview-then-confirm — the picker and the plan write
     * nothing; the person confirms the plan they were shown. The Workspace surface's hibernate /
     * wake / remove carry their own confirm and outcome, reset when the route changes workspace.
     */
    const [addPreview, setAddPreview] = useState<AddPreviewView | null>(null);
    // Add from a git URL (§6.1): the form, then the host picks the parent and the plan replaces the form.
    const [addFromGit, setAddFromGit] = useState(false);
    const workspaceId = parsed.surface === 'workspace' ? parsed.workspaceId : null;
    const [wsView, setWsView] = useState<{ removePreview: boolean; lastOutcome: string | null }>({ removePreview: false, lastOutcome: null });
    // The repo registry (§6.1) of the workspace on screen: read once per workspace, re-read after an add or remove.
    const [repos, setRepos] = useState<readonly RepoEntry[] | null>(null);
    // The workspace-scoped settings (§6.1) of the workspace on screen: its effective values and which it overrides.
    const [wsSettings, setWsSettings] = useState<{ values: Record<string, boolean | string>; overridden: string[] } | null>(null);
    const reloadWsSettings = (bridge: GenieBridge, id: string) => {
        void bridge.workspaces.settings(id).then((r) => {
            setWsSettings(r.ok ? { values: r.values, overridden: r.overridden } : { values: {}, overridden: [] });
            if (!r.ok) setWsView((v) => ({ ...v, lastOutcome: r.reason }));
        });
    };
    const reloadRepos = (bridge: GenieBridge, id: string) => {
        void bridge.workspaces.listRepos(id).then((r) => {
            setRepos(r.ok ? r.repos : []);
            if (!r.ok) setWsView((v) => ({ ...v, lastOutcome: r.reason }));
        });
    };
    useEffect(() => {
        setRepos(null);
        setWsSettings(null);
        if (resolvedBridge && workspaceId) { reloadRepos(resolvedBridge, workspaceId); reloadWsSettings(resolvedBridge, workspaceId); }
    }, [resolvedBridge, workspaceId]);
    useEffect(() => { setWsView({ removePreview: false, lastOutcome: null }); }, [workspaceId]);
    const previewAdd = () => {
        void resolvedBridge?.workspaces.previewAdd().then((p) => { if (p.ok || p.reason !== 'no folder picked') setAddPreview(p); });
    };
    const workspaceRow = workspaceId ? snapshot.workspaces?.find((w) => w.id === workspaceId) ?? null : null;
    const workspaceOps: WorkspaceOpsProps | undefined = resolvedBridge && workspaceId && workspaceRow
        ? {
              asleep: workspaceRow.asleep === true,
              agentCount: snapshot.agents.filter((a) => a.workspaceId === workspaceId).length,
              removePreview: wsView.removePreview,
              lastOutcome: wsView.lastOutcome,
              settings: {
                  values: wsSettings?.values ?? null,
                  overridden: wsSettings?.overridden ?? [],
                  onSet: (key, value) => { void resolvedBridge.workspaces.setSetting(workspaceId, key, value).then((r) => { if (r.ok) reloadWsSettings(resolvedBridge, workspaceId); else setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
                  onReset: (key) => { void resolvedBridge.workspaces.resetSetting(workspaceId, key).then((r) => { if (r.ok) reloadWsSettings(resolvedBridge, workspaceId); else setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              },
              governs: {
                  children: workspaceRow.governs ?? [],
                  candidates: (snapshot.workspaces ?? []).filter((w) => w.id !== workspaceId).map((w) => ({ id: w.id })),
                  onSet: (childIds) => { void resolvedBridge.workspaces.setGoverns(workspaceId, childIds).then((r) => { if (!r.ok) setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              },
              repos: {
                  list: repos,
                  onAdd: (input) => { void resolvedBridge.workspaces.addRepo(workspaceId, input).then((r) => { if (r.ok) reloadRepos(resolvedBridge, workspaceId); else setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
                  onRemove: (slug) => { void resolvedBridge.workspaces.removeRepo(workspaceId, slug).then((r) => { if (r.ok) reloadRepos(resolvedBridge, workspaceId); else setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
                  // Open: the files panel of this workspace (the repo's folder is in its tree). A per-folder deep link is a later row.
                  onOpen: () => navigate(`genie://workspace/${workspaceId}?panel=files`),
              },
              onHibernate: () => { void resolvedBridge.workspaces.hibernate(workspaceId).then((r) => setWsView((v) => ({ ...v, lastOutcome: r.ok ? `hibernated; handoffs landed from ${r.handoffs.landed.length === 0 ? 'nobody' : r.handoffs.landed.join(', ')}; ${r.handoffs.missing.length === 0 ? 'none missing' : `missing from ${r.handoffs.missing.join(', ')}`}` : r.reason }))); },
              onWake: () => { void resolvedBridge.workspaces.wake(workspaceId).then((r) => setWsView((v) => ({ ...v, lastOutcome: r.ok ? 'awake' : r.reason }))); },
              onPreviewRemove: () => setWsView((v) => ({ ...v, removePreview: true })),
              onCancelRemove: () => setWsView((v) => ({ ...v, removePreview: false })),
              onConfirmRemove: () => {
                  void resolvedBridge.workspaces.remove(workspaceId).then((r) => {
                      if (r.ok) navigate(DEFAULT_ROUTE);
                      else setWsView((v) => ({ ...v, removePreview: false, lastOutcome: r.reason }));
                  });
              },
          }
        : undefined;

    const [opsView, setOpsView] = useState<{ deletePreview: DeletePlan | null; diagnosis: Diagnosis | null; lastOutcome: string | null }>({ deletePreview: null, diagnosis: null, lastOutcome: null });
    useEffect(() => { setOpsView({ deletePreview: null, diagnosis: null, lastOutcome: null }); }, [agentId]);
    const agentOps: AgentOpsProps | undefined = resolvedBridge && agentId
        ? {
              deletePreview: opsView.deletePreview,
              diagnosis: opsView.diagnosis,
              lastOutcome: opsView.lastOutcome,
              budgetUsd: detail?.agent.dailyBudgetUsd ?? null,
              mode: detail?.agent.mode ?? 'manual',
              accessScope: detail?.agent.accessScope ?? 'self',
              onSetMode: (mode) => { void resolvedBridge.agents.setMode(agentId, mode).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              onSetAccessScope: (scope) => { void resolvedBridge.agents.setAccessScope(agentId, scope).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              onRestart: (kind) => { void resolvedBridge.agents.restart(agentId, kind).then((r) => setOpsView((v) => ({ ...v, lastOutcome: r.ok ? (r.kind === 'fresh' ? `restarted fresh${r.discarded ? ` — discarded conversation ${r.discarded}` : ''}` : 'restarted gracefully on the same conversation') : r.reason }))); },
              onSwitchDriver: (to) => { void resolvedBridge.agents.switchDriver(agentId, to).then((r) => setOpsView((v) => ({ ...v, lastOutcome: r.ok ? (r.noop ? `already running on ${r.to}` : `switched ${r.from} → ${r.to}; carried ${r.carries.join(', ')}. Start it when ready.`) : r.reason }))); },
              onDiagnose: () => { void resolvedBridge.agents.diagnose(agentId).then((r) => setOpsView((v) => (r.ok ? { ...v, diagnosis: r.diagnosis } : { ...v, lastOutcome: r.reason }))); },
              onPreviewDelete: (outcome) => { void resolvedBridge.agents.previewDelete(agentId, outcome, []).then((r) => setOpsView((v) => (r.ok ? { ...v, deletePreview: r.plan } : { ...v, lastOutcome: r.reason }))); },
              onConfirmDelete: (outcome, also) => {
                  void resolvedBridge.agents.delete(agentId, outcome, also).then((r) => {
                      if (r.ok) { setOpsView({ deletePreview: null, diagnosis: null, lastOutcome: null }); navigate(DEFAULT_ROUTE); }
                      else setOpsView((v) => ({ ...v, lastOutcome: r.reason }));
                  });
              },
              onCancelDelete: () => setOpsView((v) => ({ ...v, deletePreview: null })),
              onSetBudget: (usd) => { void resolvedBridge.agents.setBudget(agentId, usd).then((r) => setOpsView((v) => ({ ...v, lastOutcome: r.ok ? (r.decision.kind === 'unenforceable' ? r.decision.reason : usd === null ? 'budget cleared' : `budget set to ${usd}/day`) : r.reason }))); },
          }
        : undefined;

    /**
     * Which panel holds the single dock slot.
     *
     * View state, not route state, and deliberately: `?pin=right` in the route says a panel IS
     * pinned, and this says WHICH — but at most one can be, so the route's `chat=<agent>` plus
     * `pin=right` already describes a pinned chat completely. Keeping a second copy of "which
     * panel" in the URL would let the two disagree.
     */
    const [pinned, setPinned] = useState<DockPanel | null>(parsed.pin === 'right' ? 'chat' : null);
    // Which workspace's file panel holds the dock when files are pinned (§4.3). One panel per workspace.
    const [filesWorkspaceId, setFilesWorkspaceId] = useState<string | null>(null);
    const toggleFilesPin = (id: string) => {
        // Pinning another workspace's panel while one is pinned moves the slot to it; the same one unpins.
        const outcome = pinPanel(pinned === 'files' && filesWorkspaceId !== id ? null : pinned, 'files', false);
        if (outcome.refused !== null) return;
        setPinned(outcome.pinned);
        setFilesWorkspaceId(outcome.pinned === 'files' ? id : null);
    };
    // ⌘B / Ctrl+B toggles the file panel of the workspace on screen (§4.3). A chord, so it works while typing.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (globalAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: isTypingTarget(e.target as never) }) !== 'toggle-files') return;
            if (parsed.surface !== 'workspace') return;
            e.preventDefault();
            navigate(parsed.panel === 'files' ? `genie://workspace/${parsed.workspaceId}` : `genie://workspace/${parsed.workspaceId}?panel=files`);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [parsed]);

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
            remote={remote.state?.connected && remote.state.host ? { host: remote.state.host, driver: remote.state.driver, driving: remote.state.driving, locked: remote.state.locked } : null}
            remoteConnect={{ state: remote.state, remembered: remote.remembered, onConnect: remote.connect, onDisconnect: remote.disconnect }}
            agentOps={agentOps}
            workspaceOps={workspaceOps}
            addPreview={addPreview}
            onConfirmAdd={(path) => { void resolvedBridge?.workspaces.confirmAdd(path).then((r) => { if (r.ok) setAddPreview(null); else setAddPreview({ ok: false, reason: r.reason }); }); }}
            onCancelAdd={() => setAddPreview(null)}
            agentDetail={detail}
            agentResolved={resolved}
            selectedRowId={selectedRowId}
            chatThread={chatThread}
            pinned={pinned}
            onNavigate={navigate}
            features={features}
            onBrowserBounds={(b) => { void (resolvedBridge?.features ?? NO_FEATURES).setBrowserBounds(b); }}
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
            onAnswerDeckItem={(item, optionId) => {
                // The Deck answers for an agent the route is NOT on, so the id comes from the
                // item rather than from the URL — and the item's id says which channel it takes.
                const route = deckAnswerRoute(item, optionId);
                switch (route.kind) {
                    case 'refused':
                        console.error('[genie] deck answer refused:', route.reason);
                        return;
                    case 'feature':
                        void (resolvedBridge?.features ?? NO_FEATURES).act({ kind: 'deck.answer', item, optionId }).then(setFeatures).catch((error: unknown) => {
                            console.error('[genie] deck answer refused:', (error as Error).message);
                        });
                        return;
                    case 'navigate':
                        // Open: the window goes there itself; the finish stays on the Deck until marked read.
                        navigate(route.route);
                        return;
                    case 'restart-with-handoff':
                        void resolvedBridge?.restartWithHandoff(route.agentId, route.finishedId).then((r) => {
                            if (!r.ok) console.error('[genie] restart with handoff refused:', r.reason);
                        });
                        return;
                    case 'provider':
                        setAnswering(optionId);
                        resolvedBridge?.answerApproval(route.agentId, optionId);
                        return;
                }
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
            onAddWorkspace={previewAdd}
            addFromGit={addFromGit}
            onAddWorkspaceFromGit={() => { setAddPreview(null); setAddFromGit(true); }}
            onCancelAddGit={() => setAddFromGit(false)}
            onPreviewFromGit={(url) => { void resolvedBridge?.workspaces.previewAddFromGit(url).then((p) => { if (p.ok || p.reason !== 'no folder picked') { setAddFromGit(false); setAddPreview(p); } }); }}
            onConfirmAddGit={(url, parent) => { void resolvedBridge?.workspaces.confirmAddFromGit(url, parent).then((r) => { if (r.ok) setAddPreview(null); else setAddPreview({ ok: false, reason: r.reason }); }); }}
            terminals={resolvedBridge?.terminals ?? NO_TERMINALS}
            files={resolvedBridge?.files}
            filesWorkspaceId={filesWorkspaceId}
            onToggleFilesPin={toggleFilesPin}
            pickFiles={resolvedBridge ? () => resolvedBridge.features.pickFiles() : undefined}
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
