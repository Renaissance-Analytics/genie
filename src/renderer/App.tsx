import { AgentDetailCache, chatSubscriptionId } from './agent-detail.js';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_ROUTE, canonicalAgentRoute, carryChat, formatRoute, parseRoute } from '../core/route.js';
import { setThemePreference } from '@particle-academy/react-fancy';
import { themePreferenceFrom } from '../core/theme.js';
import { Shell } from './Shell.js';
import { TakeOverWindow } from './components/TakeOverWindow.js';
import { FilesWindow } from './components/FilesWindow.js';
import { conflictMessage, pauseMessage, resumeMessage } from '../core/files-popout.js';
import type { DockPanel } from '../core/dock.js';
import { pinPanel, routeAfterPin, type DockNotice } from '../core/dock.js';
import { approvalChoice, chatAction, globalAction, isTypingTarget } from '../core/keys.js';
import { chatSendFor, chatThreadFrom, chatThreads, draftSendVia, observedMail, rememberThread, withDrafts, type Draft } from '../core/chat-view.js';
import type { Attachment } from '../core/prompt-content.js';
import { EMPTY_SNAPSHOT, NO_FEATURES, NO_FILES, NO_TERMINALS, NO_UPDATES, SERVABLE, type AgentDetail, type GenieBridge, type GenieSnapshot } from './bridge.js';
import { EMPTY_FEATURES, toolchainRefusalOf, type FeatureData } from './features.js';
import { deckAnswerRoute } from '../core/deck-resolve.js';
import { alertsBetween, type AlertSnapshot } from '../core/alert-diff.js';
import { soundFor, toastFor } from '../core/alerts.js';
import { connectRemote, type RemoteClient, type RemoteState } from './remote-bridge.js';
import { remoteUrl, rememberedTokens } from './remote-session.js';
import { webSocketTransport } from './ws-transport.js';
import { bytesToBase64, mobileEntry, mobileView, uploadRefusal, type MobileEntry } from '../core/mobile.js';
import { MobileAgent, MobilePair, MobileShell } from './components/MobileShell.js';
import type { ChatThread } from './components/ChatFlyout.js';
import type { AgentOpsProps } from './components/AgentView.js';
import type { WorkspaceOpsProps } from './components/Workspace.js';
import type { AddPreviewView } from './components/AddWorkspacePreview.js';
import { applyOutcome, type DeletePlan } from '../core/agent-ops.js';
import type { Diagnosis } from '../core/workspace-model.js';
import type { RepoEntry } from '../core/repo-registry.js';
import { workspaceFault, type WorkspaceFault } from '../core/dashboard-view.js';
import { workspaceLabel } from '../core/workspace-label.js';

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

/**
 * The theme SETTING applied, and the host's navigation requests honoured. The `theme` setting existed and was
 * never read (the owner's light desktop showed a dark Genie with a white composer); the tray's Settings… needs
 * a way to move this window. Both are effects of data the renderer already has.
 */
function useHostRequests(bridge: GenieBridge | undefined, settings: Readonly<Record<string, boolean | string>> | null): void {
    const theme = themePreferenceFrom(settings);
    useEffect(() => { if (theme) setThemePreference(theme); }, [theme]);
    useEffect(() => {
        if (!bridge?.onNavigate) return;
        return bridge.onNavigate((route) => { window.location.hash = `#${route}`; });
    }, [bridge]);
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

/** Every agent's last detail, for the first frame of a switch (agent-detail.ts). One per window. */
const detailCache = new AgentDetailCache<AgentDetail>();

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
    /** Settle an agent ROUTE reached by name on its id. Off for the chat subject: its id must not rewrite the agent route. */
    settle = true,
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
        // A switch opens with THIS agent's last detail (none if not seen yet) — never the previous agent's ledger under
        // the new one's name, and never an empty frame for an agent already seen (the flash, 2026-10-16).
        setState(detailCache.show(agentId));

        let off: (() => void) | null = null;
        void bridge.agentDetail(agentId).then((detail) => {
            if (!live) return;
            // Live updates by the RESOLVED id: main pushes on a channel keyed by id, and a route may name the agent
            // (`chat=moic`) — subscribing by that name heard nothing, so the chat never saw a reply arrive.
            const id = chatSubscriptionId(agentId, detail);
            if (id !== null) off = bridge.subscribeAgent(id, (next) => { if (!live) return; detailCache.remember(agentId, next); setState({ detail: next, resolved: true }); });
            // Reached by name (the rail's `genie` row): settle on the id, so the live channel and every
            // link key correctly. `replace`, so Back still leaves the agent rather than bouncing here.
            const canonical = detail && settle ? canonicalAgentRoute(window.location.hash.slice(1) || '', detail.agent.id) : null;
            if (canonical) { window.location.replace(`#${canonical}`); return; }
            detailCache.remember(agentId, detail);
            setState({ detail, resolved: true });
        });
        return () => { live = false; off?.(); };
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

/** Where the chat's remembered tabs are kept between launches. */
const THREADS_KEY = 'genie.chat.threads';

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

/**
 * THE ENTRY DECISION (§6.8). Served over http at `/mobile` with no preload bridge, this renderer is a
 * phone's shell; loaded from disk by the window (or handed a bridge by a test), it is the desktop.
 * Decided once, from the page's own location — not from anything the host says.
 */
export function App({ bridge }: AppProps) {
    const [entry] = useState<MobileEntry>(() =>
        typeof window === 'undefined' ? { kind: 'desktop' } : mobileEntry(window.location, (bridge ?? window.genie) !== undefined),
    );
    return entry.kind === 'mobile' ? <MobileApp entry={entry} /> : <DesktopApp bridge={bridge} />;
}

/**
 * THE PHONE (§6.8 mobile UI: questions mirrored). One remote client to the page's own origin — the
 * QR's PIN or a remembered token dials it on arrival, otherwise the pairing form asks — then the
 * host's snapshot drives `MobileShell`. Answers take the Deck's own routing: an approval goes to
 * the provider, a feature answer to `features.act`, and an "open it" option is said to belong to
 * the desktop rather than navigating a screen that has nowhere to go.
 */
function MobileApp({ entry }: { entry: Extract<MobileEntry, { kind: 'mobile' }> }) {
    const remote = useRemote();
    const connected = remote.state?.connected === true;
    const bridge = connected ? remote.client!.bridge : undefined;
    const snapshot = useSnapshot(bridge);
    const [answering, setAnswering] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const dialed = useRef(false);
    const canDial = entry.pin !== null || remote.remembered.includes(entry.socketUrl);
    // WHAT IS ON SCREEN rides the hash (home, or one agent) so the phone's back button works. The PIN that
    // may have arrived in the hash is spent before the first view is read.
    const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash));
    useEffect(() => {
        const onHash = () => setHash(window.location.hash);
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);
    const view = mobileView(hash);
    const agentId = view.kind === 'agent' ? view.agentId : null;
    const { detail } = useAgentDetail(bridge, agentId);
    const [sending, setSending] = useState(false);
    const [upload, setUpload] = useState<{ sending: boolean; outcome: string | null }>({ sending: false, outcome: null });
    // Writes need the baton (§6.8); the phone asks for it once it is in. A refusal is said in the shell.
    const batonAsked = useRef(false);
    useEffect(() => {
        if (!connected || batonAsked.current || !remote.client) return;
        batonAsked.current = true;
        void remote.client.takeBaton().then((r) => { if (!r.ok) setNote(r.reason); });
    }, [connected, remote.client]);
    useEffect(() => {
        if (dialed.current || !canDial) return;
        dialed.current = true;
        remote.connect({ host: entry.socketUrl, pin: entry.pin ?? '', label: 'phone' });
        // The PIN is spent once dialed; a reload must not resend it (the token is remembered on welcome).
        if (entry.pin !== null) { window.history.replaceState(null, '', window.location.pathname); setHash(''); }
    }, [canDial, entry, remote]);

    if (!connected || !remote.state) {
        const connecting = remote.client !== null && (remote.state?.lastRefusal ?? null) === null;
        return <MobilePair host={window.location.host} refusal={remote.state?.lastRefusal ?? null} connecting={connecting} onConnect={({ pin, label }) => remote.connect({ host: entry.socketUrl, pin, label: label || 'phone' })} />;
    }
    const host = remote.state.host ?? window.location.host;

    // ONE AGENT: its activity, and a composer to keep it going (or Start). Back is the browser's back.
    if (agentId !== null) {
        return (
            <MobileAgent
                detail={detail}
                sending={sending}
                onBack={() => { window.history.back(); }}
                onSend={(text) => { setSending(true); void bridge!.prompt(agentId, text); setTimeout(() => setSending(false), 400); }}
                onStart={() => bridge!.openAgent(agentId)}
            />
        );
    }
    return (
        <MobileShell
            host={host}
            locked={remote.state.locked}
            refusal={note ?? remote.state.lastRefusal}
            items={snapshot.deckItems}
            answering={answering}
            onAnswer={(item, optionId) => {
                setNote(null);
                const route = deckAnswerRoute(item, optionId);
                switch (route.kind) {
                    case 'refused':
                        setNote(route.reason);
                        return;
                    case 'navigate':
                        setNote(`Open it on ${host}'s screen — this one only answers.`);
                        return;
                    case 'restart-with-handoff':
                        void bridge!.restartWithHandoff(route.agentId, route.finishedId).then((r) => { if (!r.ok) setNote(r.reason); });
                        return;
                    case 'provider':
                        setAnswering(optionId);
                        bridge!.answerApproval(route.agentId, optionId);
                        return;
                    case 'feature':
                        setAnswering(optionId);
                        void bridge!.features.act({ kind: 'deck.answer', item, optionId }).catch((error: unknown) => setNote((error as Error).message)).finally(() => setAnswering(null));
                        return;
                }
            }}
            onDisconnect={remote.disconnect}
            workspaces={snapshot.workspaces}
            agents={{
                rows: snapshot.workspaces === null ? null : snapshot.agents,
                onOpen: (id) => { window.location.hash = `#agent=${id}`; },
            }}
            upload={{
                agents: snapshot.agents.map((a) => ({ id: a.id, name: a.name, provider: a.provider, workspaceId: a.workspaceId })),
                sending: upload.sending,
                outcome: upload.outcome,
                onSend: ({ to, text, file }) => {
                    const refusal = uploadRefusal(file.name, file.size);
                    if (refusal) { setUpload({ sending: false, outcome: refusal }); return; }
                    if (!bridge?.uploads) { setUpload({ sending: false, outcome: 'this host does not take uploads' }); return; }
                    setUpload({ sending: true, outcome: null });
                    void file.arrayBuffer()
                        .then((buf) => bridge.uploads!.sendFile(to, text, file.name, bytesToBase64(new Uint8Array(buf))))
                        .then((r) => setUpload({ sending: false, outcome: r.ok ? `sent ${file.name} to ${to}` : r.reason }))
                        .catch((error: unknown) => setUpload({ sending: false, outcome: (error as Error).message }));
                },
            }}
        />
    );
}

function DesktopApp({ bridge }: AppProps) {
    const [route, navigate] = useRoute();
    const remote = useRemote();
    const resolvedBridge = remote.state?.connected ? remote.client!.bridge : (bridge ?? (typeof window === 'undefined' ? undefined : window.genie));
    const snapshot = useSnapshot(resolvedBridge);
    const [features, setFeatures] = useFeatures(resolvedBridge);
    useAlerts(snapshot, features.settings.values);
    useHostRequests(resolvedBridge, features.settings.values);

    const parsed = parseRoute(route);
    const agentId = parsed.surface === 'agent' ? parsed.agentId : null;
    const { detail, resolved } = useAgentDetail(resolvedBridge, agentId);
    // The chat subject's detail too: the flyout's transcript is derived from the same stream the Agent view reads
    // (`core/chat-view.ts`), so a chat pinned to one agent while looking at another still shows its conversation.
    const { detail: chatDetail } = useAgentDetail(resolvedBridge, parsed.chat, false);

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
    // WORKSPACE-LEVEL FAULTS for the Dashboard's group headers (a registered repo whose folder is gone): every
    // workspace's registry, read once per workspace list. Absent until read — "not seen" is not "none".
    const [workspaceFaults, setWorkspaceFaults] = useState<Record<string, WorkspaceFault | null>>({});
    // Bumped after a repo is relocated, so the faults are read again without waiting for the workspace list to change.
    const [faultsTick, setFaultsTick] = useState(0);
    const faultKey = (snapshot.workspaces ?? []).map((w) => `${w.id}\u0000${w.name ?? ''}`).join('\n');
    useEffect(() => {
        if (!resolvedBridge || !snapshot.workspaces) return;
        let live = true;
        const list = snapshot.workspaces;
        void Promise.all(list.map(async (w) => {
            const r = await resolvedBridge.workspaces.listRepos(w.id);
            const name = w.name ?? w.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? w.id;
            return [w.id, workspaceFault(r.ok ? r.repos : null, name)] as const;
        })).then((entries) => { if (live) setWorkspaceFaults(Object.fromEntries(entries)); });
        return () => { live = false; };
    }, [resolvedBridge, faultKey, faultsTick]);
    const locateRepo = (workspaceId: string, slug: string) => {
        void resolvedBridge?.workspaces.locateRepo(workspaceId, slug).then((r) => { if (r.ok) setFaultsTick((t) => t + 1); });
    };
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
                  candidates: (snapshot.workspaces ?? []).filter((w) => w.id !== workspaceId).map((w) => ({ id: w.id, name: workspaceLabel(snapshot.workspaces, w.id) })),
                  onSet: (childIds) => { void resolvedBridge.workspaces.setGoverns(workspaceId, childIds).then((r) => { if (!r.ok) setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              },
              repos: {
                  list: repos,
                  onAdd: (input) => { void resolvedBridge.workspaces.addRepo(workspaceId, input).then((r) => { if (r.ok) reloadRepos(resolvedBridge, workspaceId); else setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
                  onRemove: (slug) => { void resolvedBridge.workspaces.removeRepo(workspaceId, slug).then((r) => { if (r.ok) reloadRepos(resolvedBridge, workspaceId); else setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
                  onRemoveLock: (slug) => { void resolvedBridge.workspaces.removeRepoLock(workspaceId, slug).then((r) => { if (r.ok) reloadRepos(resolvedBridge, workspaceId); else setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
                  // Open: the files panel of this workspace (the repo's folder is in its tree). A per-folder deep link is a later row.
                  onOpen: () => navigate(`genie://workspace/${workspaceId}?files=`),
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
              autoApprove: detail?.agent.autoApprove === true,
              permissions: detail?.agent.permissions ?? 'all',
              model: detail?.agent.model ?? null,
              onSetModel: (model) => { void resolvedBridge.agents.setModel(agentId, model).then((r) => setOpsView((v) => ({ ...v, lastOutcome: r.ok ? applyOutcome(detail?.agent.name ?? 'the agent', model ?? 'the provider default', r.apply ?? { when: 'next-start' }) : r.reason }))); },
              onSetPermissions: (permissions) => { void resolvedBridge.agents.setPermissions(agentId, permissions).then((r) => setOpsView((v) => ({ ...v, lastOutcome: r.ok ? applyOutcome(detail?.agent.name ?? 'the agent', permissions === 'edits' ? 'edits only' : permissions === 'ask' ? 'asks before shell commands' : 'all tools', r.apply ?? { when: 'next-start' }) : r.reason }))); },
              onSetMode: (mode) => { void resolvedBridge.agents.setMode(agentId, mode).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              onSetAccessScope: (scope) => { void resolvedBridge.agents.setAccessScope(agentId, scope).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              onSetAutoApprove: (on) => { void resolvedBridge.agents.setAutoApprove(agentId, on).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
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
    // The docked file panel's dirty buffers (§4.4): the one thing that makes a pin refuse. Reported by the panel.
    const [filesDirty, setFilesDirty] = useState(false);
    // The dock's notice (§4.4): a handoff or a refusal, said under the title bar for a few seconds.
    const [dockNotice, setDockNotice] = useState<DockNotice | null>(null);
    useEffect(() => {
        if (!dockNotice) return;
        const t = setTimeout(() => setDockNotice(null), 8_000);
        return () => clearTimeout(t);
    }, [dockNotice]);
    // Which workspace's file panel holds the dock when files are pinned (§4.3). One panel per workspace.
    const [filesWorkspaceId, setFilesWorkspaceId] = useState<string | null>(null);
    // The panels in their own windows (§4.3): the host's list, pushed; a remote bridge has none.
    const [filesPopped, setFilesPopped] = useState<readonly string[]>([]);
    const filesWindows = resolvedBridge?.files.windows;
    useEffect(() => {
        if (!filesWindows) { setFilesPopped([]); return; }
        let live = true;
        void filesWindows.list().then((l) => { if (live) setFilesPopped(l); });
        const off = filesWindows.onChange((l) => { if (live) setFilesPopped(l); });
        return () => { live = false; off(); };
    }, [filesWindows]);
    // An agent writing a file you have dirty is ASKED to pause, over its inbox (§4.3); lifted the same way.
    const tellAgent = (agent: string, text: string) => {
        void (resolvedBridge?.features ?? NO_FEATURES).act({ kind: 'inbox.send', to: agent, text }).then(setFeatures).catch((error: unknown) => {
            console.error('[genie] pause notice not delivered:', (error as Error).message);
        });
    };
    const toggleFilesPin = (id: string) => {
        // Pinning another workspace's panel while one is pinned moves the slot to it; the same one unpins.
        const outcome = pinPanel(pinned === 'files' && filesWorkspaceId !== id ? null : pinned, 'files', filesDirty);
        if (outcome.refused !== null) { setDockNotice({ kind: 'refused', reason: outcome.refused, workspaceId: filesWorkspaceId }); return; }
        setPinned(outcome.pinned);
        setFilesWorkspaceId(outcome.pinned === 'files' ? id : null);
        if (outcome.replaced !== null) setDockNotice({ kind: 'replaced', replaced: outcome.replaced, pinned: outcome.pinned });
        // A displaced chat must leave the route too, or `pin=right` reopens it pinned on the next navigation.
        const after = routeAfterPin(route, outcome);
        if (after !== route) navigate(after);
    };
    // ⌘B / Ctrl+B toggles the file panel of the workspace on screen (§4.3); ⌘J / Ctrl+J the chat flyout on genie
    // (the board's `Chat ⌘J`). Chords, so they work while typing.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const action = globalAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: isTypingTarget(e.target as never) });
            if (action === 'toggle-chat') {
                e.preventDefault();
                navigate(parsed.chat !== null ? route.replace(/[?&]chat=[^&]*/, '').replace(/[?&]pin=[^&]*/, '') : formatRoute({ ...parsed, chat: 'genie' }));
                return;
            }
            if (action !== 'toggle-files') return;
            if (parsed.surface !== 'workspace') return;
            e.preventDefault();
            navigate(parsed.panel === 'files' ? `genie://workspace/${parsed.workspaceId}` : `genie://workspace/${parsed.workspaceId}?files=`);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [parsed, route]);
    // The chat flyout's keys (§4.4, `core/keys.ts`): Esc closes an UNPINNED flyout; A / D answer the approval parked in
    // the chat — the letters follow the composer. Never while typing.
    const chatApprovalHere = parsed.chat !== null ? chatDetail?.session?.pendingApproval ?? null : null;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const press = { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: isTypingTarget(e.target as never) };
            const action = chatAction(press, { open: parsed.chat !== null, pinned: pinned === 'chat', approval: chatApprovalHere !== null });
            if (action === null) return;
            if (action === 'close-chat') { e.preventDefault(); navigate(route.replace(/[?&]chat=[^&]*/, '').replace(/[?&]pin=[^&]*/, '')); return; }
            const optionId = approvalChoice(chatApprovalHere, action);
            if (!optionId || parsed.chat === null) return;
            e.preventDefault();
            setAnswering(optionId);
            resolvedBridge?.answerApproval(parsed.chat, optionId);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [parsed, pinned, route, chatApprovalHere, resolvedBridge]);

    /**
     * The option id currently in flight, so the buttons refuse a second press.
     *
     * Cleared when the agent's detail changes — which is when the main process has pushed the
     * answered state back. Clearing it on a timer would guess at when the provider replied.
     */
    const [answering, setAnswering] = useState<string | null>(null);
    /**
     * The last REFUSED form answer in Pending Questions, said beside that item's Answer button (the owner, 2026-10-14: "I
     * click the answer button but nothing happens" — a refusal that only reached the console was nothing happening).
     */
    const [deckFormRefusal, setDeckFormRefusal] = useState<{ itemId: string; reason: string } | null>(null);

    /**
     * The chat subject comes from the ROUTE, so a link can open a conversation. Navigation carries it (`carryChat`):
     * it stays on its agent inside a workspace and across surfaces of no workspace, and moves to an agent of the
     * workspace you arrive at when that is another one (`core/chat-scope.ts`).
     */
    const chatSubject = parsed.chat;
    // The chat's tabs: every conversation you open is remembered, newest first (eight), across restarts.
    const [openedThreads, setOpenedThreads] = useState<readonly string[]>(() => {
        try { const v: unknown = JSON.parse(window.localStorage.getItem(THREADS_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
    });
    useEffect(() => {
        if (chatSubject === null) return;
        setOpenedThreads((o) => {
            const next = rememberThread(o, chatSubject);
            try { window.localStorage.setItem(THREADS_KEY, JSON.stringify(next)); } catch { /* storage unavailable: the tabs live for this window */ }
            return next;
        });
    }, [chatSubject]);
    // The thread is DERIVED (`core/chat-view.ts`): the subject's message events with their speakers, the context
    // line, the workspace's chips. A declared agent's `unread` stays `null` — nothing reads it yet, and `0` would claim
    // you are up to date. An observed agent's thread IS its inbox thread (`observedMail`), with the inbox's own count.
    // Undelivered drafts (§4.4): a prompt the host refused because the agent was not running is KEPT here, shown in
    // the thread as not delivered, and sent by `Restart <agent> and send`. Never dropped, never shown as sent.
    const [drafts, setDrafts] = useState<readonly Draft[]>([]);
    const send = (agentId: string, text: string, attachments: readonly Attachment[] = []): void => {
        // A Take Over window has no session to prompt: its mail goes to its inbox, which its TUI reads over MCP.
        const row = snapshot.agents.find((r) => r.id === agentId);
        const route = row ? chatSendFor(row) : { kind: 'prompt' as const };
        const keep = (reason?: string): void => setDrafts((d) => [...d, { id: `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, agentId, text, at: Date.now(), ...(attachments.length > 0 ? { attachments } : {}), ...(reason ? { reason } : {}) }]);
        if (route.kind === 'inbox') {
            if (attachments.length > 0) { keep('Files cannot be sent to a Take Over window from here yet'); return; }
            void (resolvedBridge?.features ?? NO_FEATURES).act({ kind: 'inbox.send', to: route.to, text }).then(setFeatures).catch((error: unknown) => {
                console.error('[genie] mail not sent:', (error as Error).message);
            });
            return;
        }
        void resolvedBridge?.prompt(agentId, text, attachments).then((r) => {
            if (!r.ok) keep(r.reason);
        });
    };
    const restartAndSend = (draftId: string): void => {
        const draft = drafts.find((d) => d.id === draftId);
        if (!draft || !resolvedBridge) return;
        const send = () => resolvedBridge.prompt(draft.agentId, draft.text, draft.attachments ?? []).then((sent) => { if (sent.ok) setDrafts((d) => d.filter((x) => x.id !== draftId)); });
        // A broken session restarts on its thread; an agent that is not running is STARTED (a graceful restart refuses
        // one with no thread yet — a fresh install's genie).
        const session = chatDetail?.agent.id === draft.agentId || parsed.chat === draft.agentId ? chatDetail?.session ?? null : null;
        if (draftSendVia(session) === 'restart') {
            void resolvedBridge.agents.restart(draft.agentId, 'graceful').then((r) => (r.ok ? send() : undefined));
        } else {
            void Promise.resolve(resolvedBridge.openAgent(draft.agentId)).then(send);
        }
    };
    const chatBase = chatSubject === null ? null : chatThreadFrom(chatDetail, chatSubject, snapshot.agents, Date.now);
    const chatThread: ChatThread | null = chatBase === null
        ? null
        : withDrafts(chatBase.fidelity === 'observed' ? { ...chatBase, ...observedMail(features.inbox?.recent ?? null, chatBase.agentId, chatBase.name) } : chatBase, drafts);

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
    // THE FILE PANEL IN ITS OWN WINDOW (§4.3): the panel and nothing else; closing the window docks it back.
    if (parsed.surface === 'files') {
        const ws = snapshot.workspaces?.find((w) => w.id === parsed.workspaceId) ?? null;
        return (
            <FilesWindow
                workspace={ws}
                loading={snapshot.workspaces === null}
                files={resolvedBridge?.files ?? NO_FILES}
                onBringBack={() => window.close()}
                onPause={(agent: string, path: string, why?: 'conflict') => tellAgent(agent, why === 'conflict' ? conflictMessage(path) : pauseMessage(path))}
                onResume={(agent, path) => tellAgent(agent, resumeMessage(path))}
            />
        );
    }

    return (
        <Shell
            route={route}
            snapshot={snapshot}
            workspaceFaults={workspaceFaults}
            onLocateRepo={locateRepo}
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
            chatThreads={chatThreads(snapshot.agents, openedThreads, chatSubject)}
            chatSession={chatDetail?.session ?? null}
            pinned={pinned}
            // The chat rides every navigation (#258) — but arriving at ANOTHER workspace moves it to an agent of that
            // workspace (core/chat-scope.ts), so the composer never quietly keeps a project the person left (beta.26).
            onNavigate={(r) => navigate(carryChat(r, parsed, snapshot.agents, openedThreads))}
            features={features}
            onBrowserBounds={(b) => { void (resolvedBridge?.features ?? NO_FEATURES).setBrowserBounds(b); }}
            onFeature={(action) => {
                void (resolvedBridge?.features ?? NO_FEATURES).act(action).then((data) => {
                    // A refused or failed toolchain action comes back IN the snapshot and is drawn on its row
                    // (ToolchainSurface); the console keeps its line as well.
                    const refusal = toolchainRefusalOf(action, data);
                    if (refusal) console.error('[genie] feature action refused:', refusal.reason);
                    setFeatures(data);
                }).catch((error: unknown) => {
                    // A refusal is a fact the surface shows; it is never swallowed. The surfaces that do not yet
                    // carry an error line for a thrown refusal leave it here, in the console.
                    console.error('[genie] feature action refused:', (error as Error).message);
                });
            }}
            onSend={(id, text, attachments) => { if (id) send(id, text, attachments ?? []); }}
            onRestartAndSend={restartAndSend}
            answeringApproval={answering}
            onAnswerApproval={(optionId) => {
                if (!agentId) return;
                setAnswering(optionId);
                resolvedBridge?.answerApproval(agentId, optionId);
            }}
            onAnswerDeckForm={(item, selections, notes) => {
                // The filled form goes to main as one feature action — labels and one note per question; the form shows
                // no overall note. A refusal (a question with neither an option nor a note, a label that is not an
                // option) comes back as the reason and is said beside the Answer button, never only in the console.
                setDeckFormRefusal(null);
                void (resolvedBridge?.features ?? NO_FEATURES).act({ kind: 'deck.answerForm', item, selections, notes, note: '' }).then(setFeatures).catch((error: unknown) => {
                    // Electron wraps a handler's throw as "Error invoking remote method '<channel>': Error: <reason>".
                    const reason = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
                    console.error('[genie] deck form refused:', reason);
                    setDeckFormRefusal({ itemId: item.id, reason });
                });
            }}
            deckFormRefusal={deckFormRefusal}
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
                // The single slot's rule lives in `core/dock.ts`, including the file panel's refusal — real now:
                // the docked panel reports its dirty buffers (§4.4), and a refusal is said under the title bar.
                const outcome = pinPanel(pinned, 'chat', filesDirty);
                if (outcome.refused !== null) { setDockNotice({ kind: 'refused', reason: outcome.refused, workspaceId: filesWorkspaceId }); return; }
                setPinned(outcome.pinned);
                if (outcome.replaced !== null) setDockNotice({ kind: 'replaced', replaced: outcome.replaced, pinned: outcome.pinned });
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
            // From Tynn (§6.1): the host picks the parent and asks Tynn; the plan replaces whatever add was in progress.
            onAddWorkspaceFromTynn={() => {
                setAddFromGit(false);
                void resolvedBridge?.workspaces.previewAddFromTynn().then((p) => { if (p.ok || p.reason !== 'no folder picked') setAddPreview(p); });
            }}
            onConfirmAddTynn={(parent) => { void resolvedBridge?.workspaces.confirmAddFromTynn(parent).then((r) => { if (r.ok) setAddPreview(null); else setAddPreview({ ok: false, reason: r.reason }); }); }}
            terminals={resolvedBridge?.terminals ?? NO_TERMINALS}
            files={resolvedBridge?.files}
            readCommits={resolvedBridge ? (workspaceId, since) => resolvedBridge.workspaces.commitsSince(workspaceId, since).then((r) => (r.ok ? r.commits : [])) : undefined}
            filesWorkspaceId={filesWorkspaceId}
            onToggleFilesPin={toggleFilesPin}
            filesPopped={filesPopped}
            dockNotice={dockNotice}
            onDismissDockNotice={() => setDockNotice(null)}
            onFilesDirtyChange={setFilesDirty}
            onPopOutFiles={filesWindows ? (id) => {
                void filesWindows.popOut(id);
                // The route says where the panel is: on this workspace, `?files=detached`.
                if (parsed.surface === 'workspace' && parsed.workspaceId === id && !parsed.detached) navigate(formatRoute({ ...parsed, panel: 'files', file: null, filter: null, detached: true }));
            } : undefined}
            onBringBackFiles={(id) => {
                void filesWindows?.bringBack(id);
                if (parsed.surface === 'workspace' && parsed.workspaceId === id && parsed.detached) navigate(formatRoute({ ...parsed, panel: 'files', detached: false }));
            }}
            onPauseAgent={(agent: string, path: string, why?: 'conflict') => tellAgent(agent, why === 'conflict' ? conflictMessage(path) : pauseMessage(path))}
            onResumeAgent={(agent, path) => tellAgent(agent, resumeMessage(path))}
            pickFiles={resolvedBridge ? () => resolvedBridge.features.pickFiles() : undefined}
            updates={resolvedBridge?.updates ?? NO_UPDATES}
            windowChrome={resolvedBridge?.windowChrome}
            onTakeOver={(agentId) => { void resolvedBridge?.takeOver(agentId); }}
            onRestartAgent={(agentId) => { void resolvedBridge?.agents.restart(agentId, 'graceful'); }}
            onStopAgent={(agentId) => { resolvedBridge?.stopAgent(agentId); }}
            onCancelTurn={(agentId) => { void resolvedBridge?.cancelTurn(agentId); }}
            onResumeLimit={(agentId) => { void resolvedBridge?.resumeLimit(agentId); }}
            onStartAgent={(agentId) => { resolvedBridge?.openAgent(agentId); }}
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
