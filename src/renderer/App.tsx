import { AgentDetailCache, chatSubscriptionId } from './agent-detail.js';
import { CommandWindow } from './components/CommandWindow.js';
import { FlowEditorWindow } from './components/FlowEditorWindow.js';
import { WhatsNewWindow } from './components/WhatsNewWindow.js';
import { ConnectDialog } from './components/ConnectMenu.js';
import { CONNECT_ROUTE, OPEN_SHARE_LINK_ACTION, connectPaletteActions, mergeWorkstationRead, type ConnectProgress } from '../core/connect-machine.js';
import { WHATS_NEW_ROUTE } from '../core/whats-new.js';
import type { CommandItem } from '../core/command-window.js';
import { parsePromptLibrary, promptForPress, promptPaletteItems, promptTarget, type SavedPrompt } from '../core/prompt-library.js';
import { FTQ_NUDGE_TEXT, bindingsFrom, hotkeyAction } from '../core/hotkeys.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertToasts, type AlertToast } from './components/AlertToasts.js';
import { slugsFor } from '../core/address.js';
import { ChatDraftKeeper } from '../core/chat-draft-keeper.js';
/** How long Genie's own alert toast stays (genie#1211). */
const ALERT_TOAST_MS = 8_000;
import { ROW_EMOJI, ROW_EMOJI_MS, type RowSignalKind } from '../core/agent-signals.js';
import type { Headroom } from '../core/headroom.js';
import { mailSignals, type MailSignal } from '../core/mail-signals.js';
import { arrive, NO_PULSES, pulse, pulsingIds, type Pulses } from '../core/view-requests.js';
import { CHAT_LIVE_LINES } from '../core/chat-window.js';
import { DEFAULT_ROUTE, canonicalAgentRoute, carryChat, formatRoute, parseRoute, routeWorkspace } from '../core/route.js';
import { chatSubjectFor } from '../core/chat-scope.js';
import { parseTabs } from '../core/workspace-tabs.js';
import { addressOf, isInternalRoute, rehomeAddress, routeOfAddress, type AddressContext } from '../core/address.js';
import { browserPlatformHints, detectPlatform, setThemePreference } from '@particle-academy/react-fancy';
import { themePreferenceFrom } from '../core/theme.js';
import { Shell } from './Shell.js';
import { TakeOverWindow } from './components/TakeOverWindow.js';
import { FilesWindow } from './components/FilesWindow.js';
import { conflictMessage, pauseMessage, resumeMessage } from '../core/files-popout.js';
import { dockHolder, pinPanel, routeAfterPin, type DockNotice, type PinnedPanel } from '../core/dock.js';
import { approvalChoice, chatAction, globalAction, isTypingTarget } from '../core/keys.js';
import { chatAgentsKey, chatSendFor, chatThreadFrom, observedMail, rememberThread, withDrafts, type Draft } from '../core/chat-view.js';
import { deliverChat, type ChatSendOutcome } from '../core/chat-send.js';
import type { Attachment } from '../core/prompt-content.js';
import { EMPTY_SNAPSHOT, NO_FEATURES, NO_FILES, NO_TERMINALS, NO_UPDATES, SERVABLE, pageBridge, tynnBoardHostOf, type AgentDetail, type GenieBridge, type GenieSnapshot } from './bridge.js';
import { EMPTY_FEATURES, toolchainRefusalOf, type FeatureAction, type FeatureData } from './features.js';
import { deckAnswerRoute } from '../core/deck-resolve.js';
import { approvalKey, refusalWords, type ApprovalAnswering, type ApprovalRefusal } from '../core/approval-answering.js';
import type { Approval } from '../core/approval.js';
import { alertsBetween, type AlertSnapshot } from '../core/alert-diff.js';
import { ALERT_KINDS, alertDelivery, alertSound, toastFor, type AlertKind } from '../core/alerts.js';
import { toolchainSecurityAlerts } from '../core/toolchain-alerts.js';
import type { ToolStatus } from '../core/toolchain.js';
import { playAlertSound, setCustomSoundLoader } from './alert-sound.js';
import { connectRemote, type RemoteClient, type RemoteState } from './remote-bridge.js';
import { pushed, useSnapshot } from './use-snapshot.js';
import { knownHosts, openRemoteHost, relayWorkstationOf, remoteFromSearch, remoteNameFromSearch, remoteUrl, rememberedTokens, type KnownHost } from './remote-session.js';
import { RelayConnecting } from './components/RelayConnecting.js';
import type { RelayConnect } from '../core/relay-connect.js';
import { ipcRelayTransport, watchTynnSignIn, type RoleChange, type TynnWorkstationList, type TynnWorkstationRow } from './relay-transport.js';
import { ShareWorkspaceModal } from './components/ShareWorkspaceModal.js';
import { HostPathPicker, HostPathPickerContext, type PickHostPath } from './components/HostPathPicker.js';
import { AddWorkspaceModal } from './components/AddWorkspaceModal.js';
import { AddWorkspaceWizard, type SourceReadView } from './components/AddWorkspaceWizard.js';
import type { GithubAsk } from './components/AgiRemoteChoice.js';
import { GITHUB_ROUTE, type RepoListing } from '../core/github.js';
import type { TynnLinkApi } from './components/TynnProjectLink.js';
import { ImportedAgentsModal } from './components/ImportedAgents.js';
import { NewAgentModal } from './components/NewAgentModal.js';
import { importedAgentsOffer, type ImportedAgent } from '../core/agent-adoption.js';
import { pickerStart } from '../core/add-workspace.js';
import { PluginEditorsContext } from './plugin-editors-context.js';
import { PanelHostContext } from './components/PluginPane.js';
import type { ClaimingEditor } from '../core/plugin-editors.js';

const NO_PLUGIN_EDITORS: readonly ClaimingEditor[] = [];
import type { ShareLink } from '../main/tynn-share-links.js';
import { ConnectRemote } from './components/FeatureSurfaces.js';
import { upgradeHost as runHostUpgrade, type HostUpgradeStep } from '../core/host-upgrade.js';
import { webSocketTransport } from './ws-transport.js';
import { bytesToBase64, mobileEntry, mobileView, uploadRefusal, type MobileEntry } from '../core/mobile.js';
import { MobileAgent, MobilePair, MobileShell } from './components/MobileShell.js';
import type { ChatThread } from './components/ChatFlyout.js';
import type { AgentOpsProps } from './components/AgentView.js';
import type { WorkspaceOpsProps } from './components/Workspace.js';
import type { AddPreviewView } from './components/AddWorkspacePreview.js';
import { addConfirmer } from './add-confirm.js';
import type { TynnProjectsView } from './components/TynnProjectPicker.js';
import { applyOutcome, switchOutcome, type DeletePlan } from '../core/agent-ops.js';
import type { ModelChoices } from '../core/provider-models.js';
import type { Diagnosis } from '../core/workspace-model.js';
import type { RepoEntry } from '../core/repo-registry.js';
import { workspaceFault, type WorkspaceFault } from '../core/dashboard-view.js';
import { workspaceLabel } from '../core/workspace-label.js';
import { useComposerFocusLog } from './composer-focus-log.js';

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
function useHostRequests(bridge: GenieBridge | undefined, settings: Readonly<Record<string, boolean | string>> | null, onWhatsNew: () => void): void {
    const theme = themePreferenceFrom(settings);
    useEffect(() => { if (theme) setThemePreference(theme); }, [theme]);
    const whatsNew = useRef(onWhatsNew);
    whatsNew.current = onWhatsNew;
    useEffect(() => {
        if (!bridge?.onNavigate) return;
        // What's new (Help → What's new, Tynn #762) opens OVER whatever page is showing — it is not a page of its own.
        const onWhatsNew = () => whatsNew.current();
        return bridge.onNavigate((route) => {
            if (route === WHATS_NEW_ROUTE) { onWhatsNew(); return; }
            window.location.hash = `#${route}`;
        });
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

/**
 * EVERY CHAT'S KEPT DRAFT (genie#1261, core/chat-draft-keeper.ts): read from this machine's main once per bridge, and
 * `'loading'` until then, so no composer mounts before its draft is there to start from. A pending write is flushed when
 * the page goes (a reload, a quit), so the last words typed are not lost to the debounce. A bridge with no drafts (a
 * remote host) keeps none.
 */
function useChatDrafts(bridge: GenieBridge | undefined): ChatDraftKeeper | 'loading' | undefined {
    const port = bridge?.chatDrafts;
    const keeper = useMemo(() => (port ? new ChatDraftKeeper(port, { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }) : undefined), [port]);
    const [loaded, setLoaded] = useState<ChatDraftKeeper | null>(null);
    useEffect(() => {
        if (!keeper) return undefined;
        let live = true;
        void keeper.load().then(() => { if (live) setLoaded(keeper); });
        const flush = (): void => keeper.flush();
        window.addEventListener('pagehide', flush);
        return () => { live = false; window.removeEventListener('pagehide', flush); keeper.flush(); };
    }, [keeper]);
    if (!keeper) return undefined;
    return loaded === keeper ? keeper : 'loading';
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
            // A push is a transition (use-snapshot.ts `pushed`): typing is committed before it.
            if (id !== null) off = bridge.subscribeAgent(id, (next) => { if (!live) return; detailCache.remember(agentId, next); pushed(() => setState({ detail: next, resolved: true })); });
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
function useRemote(): { client: RemoteClient | null; state: RemoteState | null; remembered: string[]; known: KnownHost[]; bound: string | null; connect: (input: { host: string; pin: string; label: string }) => Promise<boolean>; disconnect: () => void; reconnect: () => void; forget: (url: string) => void; upgrade: HostUpgradeStep | null; upgradeHost: () => void; tynnWorkstations: TynnWorkstationList | null; reloadTynnWorkstations: () => void; tynnRefresh: ConnectProgress; boundName: string | null; relayConnect: RelayConnect } {
    const [client, setClient] = useState<RemoteClient | null>(null);
    const [state, setState] = useState<RemoteState | null>(null);
    const tokens = typeof window === 'undefined' ? null : rememberedTokens(window.localStorage);
    const hosts = typeof window === 'undefined' ? null : knownHosts(window.localStorage);
    const [remembered, setRemembered] = useState<string[]>(() => tokens?.hosts() ?? []);
    // The hosts this device has connected to (Tynn #819), and the host THIS window is bound to (a remote host's window).
    const [known, setKnown] = useState<KnownHost[]>(() => hosts?.list() ?? []);
    const [bound] = useState<string | null>(() => (typeof window === 'undefined' ? null : remoteFromSearch(window.location.search)));
    // A Tynn workstation's window: the machine's NAME (from the window that opened it, else Tynn's list) and where its
    // connection stands, step by step (core/relay-connect.ts). Never the raw `relay:<id>`.
    const [boundName, setBoundName] = useState<string | null>(() => (typeof window === 'undefined' ? null : remoteNameFromSearch(window.location.search)));
    const [relayConnect, setRelayConnect] = useState<RelayConnect>({ kind: 'working', step: 'tynn' });
    const last = useRef<{ url: string; label: string } | null>(null);
    // THE TYNN NETWORK (Tynn #837): main holds a Tynn workstation's connection; this window has a channel to it.
    const net = typeof window === 'undefined' ? undefined : window.genie?.tynnNetwork;
    const [tynnWorkstations, setTynnWorkstations] = useState<TynnWorkstationList | null>(null);
    // Read Tynn's list again: after a role change (W6), and each time the Connect menu or ⌘K opens (M0 finding 1). The last
    // list stays on screen while it is read; a failure keeps it and says why, with Retry (core/connect-machine.ts).
    const [tynnRefresh, setTynnRefresh] = useState<ConnectProgress>({ kind: 'idle' });
    const tynnListNow = useRef<TynnWorkstationList | null>(null);
    useEffect(() => { tynnListNow.current = tynnWorkstations; }, [tynnWorkstations]);
    const reloadTynnWorkstations = () => {
        if (!net) return;
        setTynnRefresh({ kind: 'working', step: 'Asking Tynn…' });
        const settle = (next: TynnWorkstationList) => {
            const merged = mergeWorkstationRead(tynnListNow.current, next);
            tynnListNow.current = merged.list;
            setTynnWorkstations(merged.list);
            setTynnRefresh(merged.problem ? { kind: 'failed', reason: merged.problem } : { kind: 'idle' });
        };
        net.workstations().then(settle, (error: unknown) => settle({ ok: false, reason: error instanceof Error ? error.message : String(error) }));
    };
    // Read again whenever this Genie's Tynn sign-in changes (Tynn #850): read once at open, signing in afterwards left it
    // saying "sign in to Tynn".
    useEffect(() => {
        const features = typeof window === 'undefined' ? undefined : window.genie?.features;
        if (!net || !features) return;
        const read = () => { void net.workstations().then(setTynnWorkstations, (error: unknown) => setTynnWorkstations({ ok: false, reason: error instanceof Error ? error.message : String(error) })); };
        return watchTynnSignIn(features, read);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

    const connectWith = ({ host, pin, label }: { host: string; pin: string; label: string }): Promise<boolean> => {
            const url = remoteUrl(host);
            if (!url.ok) { setState((s) => ({ ...(s ?? EMPTY_REMOTE), lastRefusal: url.reason })); return Promise.resolve(false); }
            client?.close();
            const workstationId = relayWorkstationOf(url.url);
            if (workstationId !== null) {
                if (!net) { setState((s) => ({ ...(s ?? EMPTY_REMOTE), lastRefusal: 'Tynn workstations open from Genie on a desktop' })); return Promise.resolve(false); }
                last.current = { url: url.url, label };
                setRelayConnect({ kind: 'working', step: 'tynn' });
                // Main says when Tynn gave the way in and it is reaching the machine.
                const offStep = net.onOpenStep?.((id, step) => { if (id === workstationId) setRelayConnect({ kind: 'working', step }); });
                return net.open(workstationId).then((opened) => {
                    offStep?.();
                    if (!opened.ok) {
                        setRelayConnect({ kind: 'failed', step: opened.stage ?? 'tynn', reason: opened.reason, ...(opened.offline ? { offline: true } : {}) });
                        setState((s) => ({ ...(s ?? EMPTY_REMOTE), lastRefusal: opened.reason }));
                        return false;
                    }
                    setRelayConnect({ kind: 'working', step: 'host' });
                    const transport = ipcRelayTransport(net, opened.channel);
                    // This machine's Genie browser, which main points at THIS workstation's sites over this window's channel.
                    const localBrowser = window.genie?.browserWindow;
                    const next = connectRemote(transport, { kind: 'relay', label: label || 'another screen' }, label || 'another screen', localBrowser ? { browse: (address, hosts) => localBrowser.open(address, hosts) } : {});
                    setClient(next);
                    setState(next.state());
                    return next.ready.then((r) => {
                        if (r.ok && hosts) { hosts.noteConnected(url.url, next.state().host, Date.now()); setKnown(hosts.list()); }
                        // The relay's or the host's own words beat the protocol's generic close.
                        if (!r.ok) {
                            const reason = transport.closedBecause() ?? r.reason;
                            setRelayConnect({ kind: 'failed', step: 'host', reason });
                            setState((s) => ({ ...(s ?? EMPTY_REMOTE), lastRefusal: reason }));
                        }
                        return r.ok;
                    });
                });
            }
            const token = tokens?.tokenFor(url.url) ?? null;
            const auth = pin.trim() ? { kind: 'pin' as const, code: pin.trim(), label } : token ? { kind: 'token' as const, token, label } : null;
            if (!auth) { setState((s) => ({ ...(s ?? EMPTY_REMOTE), lastRefusal: 'type the PIN shown on that machine — this device has not paired with it yet' })); return Promise.resolve(false); }
            const next = connectRemote(webSocketTransport(url.url), auth, label || 'another screen');
            last.current = { url: url.url, label };
            setClient(next);
            setState(next.state());
            return next.ready.then((r) => {
                if (r.ok) {
                    const t = next.state().token;
                    if (t && tokens) { tokens.remember(url.url, t); setRemembered(tokens.hosts()); }
                    // A known host, with its own name and when (Genie 1's remote.known).
                    if (hosts) { hosts.noteConnected(url.url, next.state().host, Date.now()); setKnown(hosts.list()); }
                }
                else setState((s) => ({ ...(s ?? EMPTY_REMOTE), lastRefusal: r.reason }));
                return r.ok;
            });
    };
    const connectTo = (url: string, label: string): Promise<boolean> => connectWith({ host: url, pin: '', label });
    // UPGRADE THE CONNECTED HOST (Tynn #822; Genie 1's remote.upgradeHost): its own updater over the link; the drop while
    // it restarts is expected, and the window reconnects until it answers (core/host-upgrade.ts).
    const [upgrade, setUpgrade] = useState<HostUpgradeStep | null>(null);
    const startUpgrade = (): void => {
        const c = client;
        const target = last.current;
        if (!c || !target) return;
        void runHostUpgrade({
            updates: { check: () => c.bridge.updates.check(), download: () => c.bridge.updates.download(), install: () => c.bridge.updates.install() },
            reconnect: () => connectTo(target.url, target.label),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            now: () => Date.now(),
            onStep: setUpgrade,
        });
    };
    // A remote host's window connects on open, with the token this device holds (no PIN: it was paired before).
    useEffect(() => { if (bound) void connectTo(bound, ''); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    // A Tynn workstation's window opened without its name (an older opener): Tynn's list names it.
    useEffect(() => {
        const id = bound ? relayWorkstationOf(bound) : null;
        if (id === null || boundName !== null || !net) return;
        void net.workstations().then((list) => { const w = list.ok ? list.workstations.find((x) => x.id === id) : undefined; if (w) setBoundName(w.name); }, () => {});
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    // A Tynn workstation's connection that DROPPED after it was up: said at its last step, with Retry.
    const wasConnected = useRef(false);
    useEffect(() => {
        if (state?.connected) { wasConnected.current = true; return; }
        if (!wasConnected.current || !bound || relayWorkstationOf(bound) === null) return;
        wasConnected.current = false;
        setRelayConnect({ kind: 'failed', step: 'host', reason: state?.lastRefusal ?? 'The connection dropped.' });
    }, [state?.connected]); // eslint-disable-line react-hooks/exhaustive-deps
    return {
        client,
        state,
        remembered,
        connect: connectWith,
        disconnect: () => { client?.close(); setClient(null); setState(null); },
        known,
        bound,
        // The link dropped (Genie 1's remote.reconnect): the same host again, with the token this device holds.
        reconnect: () => { const l = last.current ?? (bound ? { url: bound, label: '' } : null); if (l) void connectTo(l.url, l.label); },
        upgrade,
        upgradeHost: startUpgrade,
        forget: (url: string) => { hosts?.forget(url); setKnown(hosts?.list() ?? []); setRemembered(tokens?.hosts() ?? []); },
        tynnWorkstations,
        reloadTynnWorkstations,
        tynnRefresh,
        boundName,
        relayConnect,
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
function useAlerts(snapshot: GenieSnapshot, settings: Readonly<Record<string, boolean | string>> | null, show: (toast: { title: string; body: string; color?: string }) => void): void {
    const prev = useRef<AlertSnapshot | null>(null);
    useEffect(() => {
        const next: AlertSnapshot = { deckItems: snapshot.deckItems, agents: snapshot.agents.map((a) => ({ id: a.id, name: a.name, workspaceId: a.workspaceId, state: a.state, reason: a.reason })) };
        if (snapshot.deckItems !== null) {
            for (const alert of alertsBetween(prev.current, next)) {
                // The chosen sound — a wav or the Default chime — through the one player Preview uses too.
                playAlertSound(alertSound(alert.kind, settings ?? {}));
                // The agent's workspace colour beside its address (genie#1300).
                const color = snapshot.workspaces?.find((w) => w.id === alert.workspace)?.color;
                show({ ...toastFor(alert, slugsFor(snapshot.workspaces ?? [])), ...(color ? { color } : {}) });
            }
            prev.current = next;
        }
    }, [snapshot, settings]);
}

/**
 * THE DRIFT WATCHER'S ALARM (core/toolchain-alerts.ts): the toolchain probe's statuses arrive with the feature data; a
 * tool newly under its security floor raises the `ghsecurity` alert once — the sound and notification the person set
 * for "a security alert" — the moment the probe reports it, not when Settings is next opened.
 */
function useToolchainSecurityAlerts(tools: readonly ToolStatus[] | null, settings: Readonly<Record<string, boolean | string>> | null, show: (toast: { title: string; body: string }) => void): void {
    const prev = useRef<readonly ToolStatus[] | null>(null);
    useEffect(() => {
        if (tools === null) return;
        for (const alert of toolchainSecurityAlerts(prev.current, tools)) {
            playAlertSound(alertSound(alert.kind, settings ?? {}));
            show(toastFor(alert));
        }
        prev.current = tools;
    }, [tools, settings]);
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
    // The option id in flight (the phone shows one agent's one question at a time); ended by the host's reply, always.
    const [inFlight, setInFlight] = useState<string | null>(null);
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
                // The phone's Start is the one restart too (genie#1238).
                onStart={() => { void bridge!.agents.restart(agentId, 'graceful'); }}
                onResumeLimit={() => { void bridge!.resumeLimit(agentId); }}
            />
        );
    }
    return (
        <MobileShell
            host={host}
            locked={remote.state.locked}
            refusal={note ?? remote.state.lastRefusal}
            items={snapshot.deckItems}
            answering={inFlight}
            onAnswer={(item, optionId, answerNote) => {
                setNote(null);
                const route = deckAnswerRoute(item, optionId, answerNote ?? '');
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
                        // The host's reply ends the flight; its refusal is said in the shell (it used to be set and never cleared here too).
                        setInFlight(optionId);
                        void bridge!.answerApproval(route.agentId, optionId, route.note).then((r) => { if (!r.ok) setNote(refusalWords(r)); }, (error: unknown) => setNote((error as Error).message)).finally(() => setInFlight(null));
                        return;
                    case 'feature':
                        setInFlight(optionId);
                        void bridge!.features.act({ kind: 'deck.answer', item, optionId, ...(answerNote ? { note: answerNote } : {}) }).catch((error: unknown) => setNote((error as Error).message)).finally(() => setInFlight(null));
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
    // The hash holds the ADDRESS (genie://{workstation}/{workspace-slug}/{tab}, core/address.ts, Tynn #831); the app
    // works in internal routes. Derived on every render, so an address resolves as soon as the snapshot can name it.
    const [address, writeAddress] = useRoute();
    const remote = useRemote();
    // A REMOTE WINDOW ASKED TO RECONNECT (genie#1278, M0 finding 2): its connection dropped and the person pressed Open, so
    // main asks it to connect again — with a grant minted now, under the account signed in now — instead of only focusing.
    const reconnectNow = useRef(remote.reconnect);
    reconnectNow.current = remote.reconnect;
    useEffect(() => (typeof window === 'undefined' ? undefined : window.genie?.remoteWindows?.onReconnectAsked?.(() => reconnectNow.current())), []);
    // The window's own bridge goes through `pageBridge`: an agent's detail crosses the preload as a patch and is rebuilt here.
    const resolvedBridge = remote.state?.connected ? remote.client!.bridge : (bridge ?? (typeof window === 'undefined' || window.genie === undefined ? undefined : pageBridge(window.genie)));
    /**
     * The Tynn tab's host, ONE object per bridge (genie#1295 B4). Built inline it was a new object on every render of this
     * window, and the tab keys its read and its live subscription on it: every render re-read the whole board and signed
     * a new socket (the B4 end-to-end run on omarchy-test: 10 whole-board re-reads and 8 channel signatures for one tab).
     */
    const tynnBoardHost = useMemo(() => tynnBoardHostOf(resolvedBridge), [resolvedBridge]);
    /**
     * THE ONE RESTART (genie#1238): every Start and Restart in this window — the Agent view's header, the Dashboard's
     * broken row and lane, the chat — calls this, and it is main's `restartAgent(…, 'graceful')`: it works from every
     * state (a Broken agent starts again; a stopped or never-started one starts) and sends what the agent is owed.
     */
    const restartOne = (agentId: string): Promise<{ ok: true } | { ok: false; reason: string }> =>
        resolvedBridge ? resolvedBridge.agents.restart(agentId, 'graceful') : Promise.resolve({ ok: false, reason: 'Genie is not connected.' });
    const snapshot = useSnapshot(resolvedBridge);
    // A workspace's designed tabs, once its settings are read (its tab addresses resolve from them).
    const [tabsByWorkspace, setTabsByWorkspace] = useState<ReadonlyMap<string, ReadonlyArray<{ id: string; name: string }>>>(() => new Map());
    const addressContext: AddressContext | null = snapshot.workstation && snapshot.workspaces
        ? { workstation: snapshot.workstation.name, workspaces: snapshot.workspaces, agents: snapshot.osAgent ? [...snapshot.agents, snapshot.osAgent] : snapshot.agents, tabsOf: (id) => tabsByWorkspace.get(id) }
        : null;
    // Not readable yet (no snapshot): an old internal route is used as it is; an address waits on the Dashboard.
    const route = addressContext
        ? routeOfAddress(address, addressContext) ?? DEFAULT_ROUTE
        : isInternalRoute(address) ? address : DEFAULT_ROUTE;
    /*
     * WHERE AN AGENT ACTED (genie#1265; the owner, 2026-10-27): an agent's file, tab or site never moves this window — its
     * workspace is marked, and the rail row (and the Dashboard's header) pulses until the person ARRIVES there; the arrival
     * clears it and opens what the agent opened in the workspace's file panel (core/view-requests.ts). The arrival is read
     * from the route, so every way the person moves counts — a click, a key, the palette, a notification, Back.
     */
    const [pulses, setPulses] = useState<Pulses>(NO_PULSES);
    const pulsesRef = useRef(pulses);
    pulsesRef.current = pulses;
    useEffect(() => resolvedBridge?.onWorkspacePulse?.((p) => setPulses((s) => pulse(s, p))), [resolvedBridge]);
    const arriveAt = (at: string): void => {
        const arrived = arrive(pulsesRef.current, at);
        if (arrived.pulses === pulsesRef.current) return;
        pulsesRef.current = arrived.pulses;
        setPulses(arrived.pulses);
        // Replaced, not pushed: the person's own navigation is the history entry; this only fills in what waited there.
        if (arrived.show !== null) window.location.replace(`#${addressContext ? addressOf(arrived.show, addressContext) : arrived.show}`);
    };
    useEffect(() => { arriveAt(route); }, [route]);
    // Clicking the row of the workspace already on screen moves no hash, and is an arrival all the same.
    const navigate = (next: string): void => { if (next === route) { arriveAt(next); return; } writeAddress(addressContext ? addressOf(next, addressContext) : next); };
    // An OLD address (genie://workspace/<id>?chat=…, a link, a host navigation) is rewritten in place to the new form.
    const shownAddress = addressContext ? addressOf(route, addressContext) : address;
    useEffect(() => {
        if (!addressContext || shownAddress === address || !isInternalRoute(address)) return;
        window.location.replace(`#${shownAddress}`);
    }, [address, shownAddress, addressContext !== null]);
    // LEAVING A REMOTE HOST (the two-VM proof, 2026-10-20): the address named that machine; once this window's own snapshot
    // names this one, the same page comes back here — Disconnect on the host's Remote access lands on this machine's Remote
    // access (the host it left is listed there), not the Dashboard. Not in a window BOUND to a host: it waits for its host.
    const leftHost = useRef<string | null>(null);
    useEffect(() => {
        if (remote.state?.connected && remote.state.host) { leftHost.current = remote.state.host; return; }
        const from = leftHost.current;
        const here = snapshot.workstation?.name;
        if (remote.bound || from === null || !here || here.toLowerCase() === from.toLowerCase()) return;
        leftHost.current = null;
        const next = rehomeAddress(address, from, here);
        if (next !== address) window.location.replace(`#${next}`);
    }, [remote.state?.connected, remote.state?.host, remote.bound, snapshot.workstation?.name, address]);
    const [features, setFeatures] = useFeatures(resolvedBridge);
    // The editors of the plugins enabled on the host (beta.33 item 14): the file panel routes claimed files to them.
    const pluginEditors = features.plugins?.editors ?? NO_PLUGIN_EDITORS;
    // The official panels' host calls (beta.33 item 14): the Repository panel's git, the ArtBoard, the files watcher.
    const panelHost = useMemo(() => ({ repo: resolvedBridge?.repo, artboard: resolvedBridge?.artboard, files: resolvedBridge?.files }), [resolvedBridge]);
    // An alert's own sound file is read by main, by key (Tynn #766 B2): the one player asks through this bridge.
    useEffect(() => { if (resolvedBridge) setCustomSoundLoader((key) => resolvedBridge.features.soundData(key)); }, [resolvedBridge]);
    const keptDrafts = useChatDrafts(resolvedBridge);
    // An alert's toast (genie#1211): Genie in front → its own, bottom-left, clear of the chat; behind → the OS notification.
    const [alertToasts, setAlertToasts] = useState<readonly AlertToast[]>([]);
    const dismissAlert = useCallback((id: string) => setAlertToasts((prev) => prev.filter((t) => t.id !== id)), []);
    const showAlert = useCallback((toast: { title: string; body: string; color?: string }) => {
        if (alertDelivery(typeof document !== 'undefined' && document.hasFocus()) === 'in-app') {
            const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            setAlertToasts((prev) => [...prev.slice(-3), { id, ...toast }]);
            setTimeout(() => dismissAlert(id), ALERT_TOAST_MS);
        } else if (typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
            try { new Notification(toast.title, { body: toast.body }); } catch { /* no notification surface here */ }
        }
    }, [dismissAlert]);
    useAlerts(snapshot, features.settings.values, showAlert);
    useToolchainSecurityAlerts(features.toolchain?.tools ?? null, features.settings.values, showAlert);
    // EVERY KIND OF ACTION (Tynn #766 C): what an agent just did, pushed by main; the sound chosen for it, if any.
    const soundSettings = useRef(features.settings.values);
    soundSettings.current = features.settings.values;
    // ...and the row's emoji (genie#1209): 👍 thumbsUp, ✅ imDone, 🧞 a Genie action, on that agent's row for a moment.
    const [rowEmoji, setRowEmoji] = useState<Readonly<Record<string, string>>>({});
    // Each provider's rate limit for the Dashboard header (buffered in main; this only stores what arrives).
    const [rateLimits, setRateLimits] = useState<Readonly<Record<string, Headroom>>>({});
    useEffect(() => resolvedBridge?.onHeadroom?.(setRateLimits), [resolvedBridge]);
    useEffect(() => resolvedBridge?.onAction?.((action) => {
        if (ALERT_KINDS.some((k) => k.kind === action.kind)) playAlertSound(alertSound(action.kind as AlertKind, soundSettings.current ?? {}));
        const emoji = action.agentId ? ROW_EMOJI[action.kind as RowSignalKind] : undefined;
        if (emoji && action.agentId) {
            const id = action.agentId;
            setRowEmoji((prev) => ({ ...prev, [id]: emoji }));
            setTimeout(() => setRowEmoji((prev) => { if (prev[id] !== emoji) return prev; const next = { ...prev }; delete next[id]; return next; }), ROW_EMOJI_MS);
        }
    }), [resolvedBridge]);
    // MAIL BETWEEN AGENTS ON THE BOARD (genie#1209): a send starts a signal, a read marks it, a tick lets it go.
    const [mailSignalList, setMailSignalList] = useState<readonly MailSignal[]>([]);
    useEffect(() => resolvedBridge?.onAction?.((action) => {
        if (action.kind === 'mail-sent' && action.agentId && action.to && action.id) setMailSignalList((s) => mailSignals(s, { kind: 'sent', id: action.id!, from: action.agentId!, to: action.to!, at: Date.now() }));
        else if (action.kind === 'mail-read' && action.ids) setMailSignalList((s) => mailSignals(s, { kind: 'read', ids: action.ids!, at: Date.now() }));
    }), [resolvedBridge]);
    useEffect(() => {
        if (mailSignalList.length === 0) return;
        const t = setInterval(() => setMailSignalList((s) => mailSignals(s, { kind: 'tick', at: Date.now() })), 1_000);
        return () => clearInterval(t);
    }, [mailSignalList.length]);
    const featureAct = (action: FeatureAction, what: string) => {
        void (resolvedBridge?.features ?? NO_FEATURES).act(action).then(setFeatures).catch((error: unknown) => {
            console.error(`[genie] ${what}:`, (error as Error).message);
        });
    };
    useHostRequests(resolvedBridge, features.settings.values, () => featureAct({ kind: 'whatsNew.show' }, 'What’s new did not open'));
    // The add-workspace remote choice's GitHub asks (Add workspace parity 10): sign in where Settings does it, GitHub's own
    // install chooser, one installation's page (to approve the permission creating a repository needs), or read the
    // installations again after installing.
    const githubAsk = (ask: GithubAsk) => {
        if (typeof ask === 'object') featureAct({ kind: 'integrations.githubOpen', target: { page: 'installation', installationId: ask.approve } }, 'GitHub’s installation page did not open');
        else if (ask === 'sign-in') navigate(GITHUB_ROUTE);
        else if (ask === 'install') featureAct({ kind: 'integrations.githubOpen', target: { page: 'install' } }, 'GitHub’s install page did not open');
        else featureAct({ kind: 'integrations.githubRefresh' }, 'GitHub was not read again');
    };

    const parsed = parseRoute(route);
    const agentId = parsed.surface === 'agent' ? parsed.agentId : null;
    const { detail, resolved } = useAgentDetail(resolvedBridge, agentId);
    // Every conversation you open is remembered, newest first (eight), across restarts: a workspace's chat opens on the latest.
    const [openedThreads, setOpenedThreads] = useState<readonly string[]>(() => {
        try { const v: unknown = JSON.parse(window.localStorage.getItem(THREADS_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
    });
    // ALWAYS a chat, and the VIEW decides whose (the owner, 2026-10-19): an agent's tab → that agent; a workspace → its
    // default agent; anything else → genie (core/chat-scope.ts chatSubjectFor).
    // The agent picked on the Dashboard (genie#1209): the window's, never the address's; gone once the Dashboard is left.
    const [dashboardChat, setDashboardChat] = useState<string | null>(null);
    useEffect(() => { if (parsed.surface !== 'dashboard') setDashboardChat(null); }, [parsed.surface]);
    const chatSubject = chatSubjectFor(parsed, snapshot.agents, snapshot.workspaces ?? [], dashboardChat);
    // The chat SUBJECT's detail — never the route's `chat=` alone (the owner, 2026-10-19, three times: "THE CHAT DOES NOT
    // EVER CLOSE"). The subject is permanent (the route's, else the agent the view says); loading only for `chat=` left
    // every page reached without it showing an empty chat, which reads as a closed one. The flyout's transcript is derived
    // from the same stream the Agent view reads (`core/chat-view.ts`).
    const { detail: chatDetail } = useAgentDetail(resolvedBridge, chatSubject, false);

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
    // The Command Window's two ways to another machine (genie#1278 C1), each in its own window.
    const [connectDialog, setConnectDialog] = useState<'link' | 'workstations' | null>(null);
    // A role change (genie#1278 W6) through main, which asks Tynn; then the list is read again, so it shows Tynn's answer.
    const setWorkstationRole = async (w: TynnWorkstationRow, role: 'pilot' | 'drone', code: string): Promise<RoleChange> => {
        const net = typeof window === 'undefined' ? undefined : window.genie?.tynnNetwork;
        if (!net?.setRole) return { ok: false, reason: 'Roles change from Genie on a desktop' };
        const result = await net.setRole(w.id, role, code);
        if (result.ok) remote.reloadTynnWorkstations();
        return result;
    };
    // The confirmed add is running (parity row 25), and the ONE controller every non-New confirm goes through: one add at
    // a time, busy for the whole run, and the workspace it added opened, as New opens its own (row 38; add-confirm.ts).
    const [addBusy, setAddBusy] = useState(false);
    const navigateRef = useRef(navigate);
    navigateRef.current = navigate;
    /*
     * "IT CAME WITH AGENTS" (Add workspace parity item 6; Genie 1's WorkspaceBroughtAgents): after ANY add, the `.agents/*`
     * the workspace brought and has not registered, offered for adoption over the workspace it opened. Nothing to offer =
     * no screen; a list the host cannot read = no screen (the workspace is added; this must not hold it hostage).
     */
    const [cameWith, setCameWith] = useState<{ workspaceId: string; agents: readonly ImportedAgent[] } | null>(null);
    /** The workspace whose New agent form is open, or `null`. */
    const [newAgentFor, setNewAgentFor] = useState<string | null>(null);
    const offerAgentsRef = useRef<(id: string) => void>(() => {});
    offerAgentsRef.current = (id) => {
        const read = resolvedBridge?.workspaces.importedAgents;
        if (!read) return;
        void read(id).then((r) => { if (r.ok && importedAgentsOffer(r.agents).offer) setCameWith({ workspaceId: id, agents: r.agents }); }, () => {});
    };
    const confirmAddOnce = useMemo(() => addConfirmer(() => ({ setBusy: setAddBusy, setPreview: setAddPreview, open: (route) => navigateRef.current(route), added: (id) => offerAgentsRef.current(id) })), []);
    // Add from a git URL (§6.1): the form, then the host picks the parent and the plan replaces the form.
    const [addFromGit, setAddFromGit] = useState(false);
    // From Tynn (§6.1): the person's projects while picking one; `undefined` when not picking.
    const [tynnPick, setTynnPick] = useState<TynnProjectsView | undefined>(undefined);
    // The workspace on screen — its own views, or one of its agents' pages, which sit under its strip (Tynn #805).
    const workspaceId = routeWorkspace(route, snapshot.agents);
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
        // Opens in the envelope: the repo's folder is inside it (Tynn #835).
        const envelope = snapshot.workspaces?.find((w) => w.id === workspaceId)?.path;
        void pickFolder(`Where is ${slug} now? Pick its folder inside the envelope`, envelope).then((path) => {
            if (path) void resolvedBridge?.workspaces.locateRepo(workspaceId, slug, path).then((r) => { if (r.ok) setFaultsTick((t) => t + 1); });
        });
    };
    // The workspace-scoped settings (§6.1) of the workspace on screen: its effective values and which it overrides.
    const [wsSettings, setWsSettings] = useState<{ values: Record<string, boolean | string>; overridden: string[] } | null>(null);
    const reloadWsSettings = (bridge: GenieBridge, id: string) => {
        void bridge.workspaces.settings(id).then((r) => {
            setWsSettings(r.ok ? { values: r.values, overridden: r.overridden } : { values: {}, overridden: [] });
            // Its designed tabs, for their addresses (core/address.ts).
            const raw = r.ok ? r.values['workspace_tabs'] : undefined;
            setTabsByWorkspace((m) => new Map(m).set(id, parseTabs(typeof raw === 'string' ? raw : '').tabs.map((t) => ({ id: t.id, name: t.name }))));
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
    // A workspace setting changed in main — the tabs an agent made (beta.35 item 36): the workspace on screen reloads its
    // settings at once. Pushed, never polled; a window driving another machine has no push and reloads as before.
    useEffect(() => {
        if (!resolvedBridge || !workspaceId) return;
        return resolvedBridge.workspaces.onSettingsChanged?.((changed) => { if (changed === workspaceId) reloadWsSettings(resolvedBridge, workspaceId); });
    }, [resolvedBridge, workspaceId]);
    useEffect(() => { setWsView({ removePreview: false, lastOutcome: null }); }, [workspaceId]);
    /*
     * THE WORKSPACE'S AGENT ROSTER (agent management parity item 2; Genie 1's agents:roster / agents:adopt): its
     * `.agents/*` with no registration here, read again whenever its registered agents change — an unmount is one — and
     * Reattach adopts one (agent-adoption's rules). A host that cannot read them offers no roster.
     */
    const wsAgentNames = workspaceId ? snapshot.agents.filter((a) => a.workspaceId === workspaceId).map((a) => a.name).sort().join(',') : '';
    const [roster, setRoster] = useState<{ workspaceId: string; onDisk: readonly ImportedAgent[] | null; busy: string | null; notice: string | null; error: string | null } | null>(null);
    const readRoster = (bridge: GenieBridge, id: string) => {
        const read = bridge.workspaces.importedAgents;
        if (!read) return;
        void read(id).then(
            (r) => setRoster((s) => (s && s.workspaceId === id ? { ...s, onDisk: r.ok ? r.agents : [], error: r.ok ? s.error : r.reason } : s)),
            (e: unknown) => setRoster((s) => (s && s.workspaceId === id ? { ...s, onDisk: [], error: e instanceof Error ? e.message : String(e) } : s)),
        );
    };
    useEffect(() => { setRoster(workspaceId ? { workspaceId, onDisk: null, busy: null, notice: null, error: null } : null); }, [workspaceId]);
    useEffect(() => { if (resolvedBridge && workspaceId) readRoster(resolvedBridge, workspaceId); }, [resolvedBridge, workspaceId, wsAgentNames]);
    // ADD A WORKSPACE (Tynn #835): the folder is picked over the HOST's disk — the remote machine's, when this window
    // drives one — then the plan is shown before anything is written.
    // THE WINDOW'S ONE PICKER (Tynn #835): every file and folder is chosen over the HOST's disk — the remote machine's
    // when this window drives one — by promise; `null` when cancelled.
    const [pickerAsk, setPickerAsk] = useState<{ opts: Parameters<PickHostPath>[0]; resolve: (picked: string | string[] | null) => void } | null>(null);
    const pickHostPath: PickHostPath | null = resolvedBridge?.host ? (opts) => new Promise((resolve) => setPickerAsk({ opts, resolve })) : null;
    const pickFolder = (title: string, initialPath?: string): Promise<string | null> =>
        pickHostPath ? pickHostPath({ mode: 'directory', title, ...(initialPath ? { initialPath } : {}) }).then((p) => (typeof p === 'string' ? p : null)) : Promise.resolve(null);
    /*
     * ADD A WORKSPACE — GENIE 1'S MODAL (the owner, 2026-10-21: "Look at Genie 1 … I can't create workspaces at all right
     * now"): "How should Genie start?", then New workspace (a name and a folder; Genie makes it), Open existing folder,
     * Import from Git, Import from Tynn. Every folder picker here opens at the Primary workspace (Settings → General), else
     * the host's home — never the bare drive list when anything better is known (core/add-workspace.ts `pickerStart`).
     */
    const [addOpen, setAddOpen] = useState(false);
    const [hostHome, setHostHome] = useState<string | null>(null);
    useEffect(() => { void resolvedBridge?.host?.home?.().then(setHostHome, () => {}); }, [resolvedBridge]);
    const primaryWorkspace = typeof features.settings.values?.['primary_workspace'] === 'string' ? (features.settings.values['primary_workspace'] as string) : '';
    const addStart = pickerStart({ primaryWorkspace, home: hostHome });
    const hostSep = /\\/.test(primaryWorkspace || hostHome || '') ? '\\' : '/';
    const previewAdd = () => { setAddPreview(null); setAddFromGit(false); setTynnPick(undefined); setAddOpen(true); };
    /*
     * OPEN EXISTING FOLDER / IMPORT FROM GIT (Add workspace parity item 7): Genie 1's wizard — the folder (or an import's
     * staging clone) is READ, then a NEW <slug>.agi is built beside it; the source is never written. A host without the
     * wizard (an older Genie this window drives) keeps the plan-then-confirm it had.
     */
    const [wizardRead, setWizardRead] = useState<SourceReadView | null>(null);
    // GENIE 1'S OPTIONAL TYNN PROJECT (Add workspace parity item 5), on New and on the wizard's Workspace step: the host's own
    // list, and — where the host can — creating one. One object per bridge, so the picker reads the list once per opening.
    const tynnLinkApi = useMemo<TynnLinkApi | undefined>(() => {
        const ws = resolvedBridge?.workspaces;
        if (!ws?.tynnProjects) return undefined;
        return {
            projects: () => ws.tynnProjects().then((r) => (r.ok ? { ok: true as const, projects: r.projects } : r)),
            ...(ws.tynnOwnerOptions ? { ownerOptions: () => ws.tynnOwnerOptions!() } : {}),
            ...(ws.createTynnProject ? { createProject: (input: Parameters<NonNullable<TynnLinkApi['createProject']>>[0]) => ws.createTynnProject!(input) } : {}),
        };
    }, [resolvedBridge]);
    const openExisting = () => {
        setAddOpen(false);
        void pickFolder('Open an existing folder', addStart).then((path) => {
            if (!path) return;
            const read = resolvedBridge?.workspaces.readSource;
            if (!read) { void resolvedBridge?.workspaces.previewAdd(path).then(setAddPreview); return; }
            void read(path).then((r) => (r.ok ? setWizardRead(r) : setAddPreview(r)), (e: unknown) => setAddPreview({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
        });
    };
    const importFromGit = (url: string) => {
        const stage = resolvedBridge?.workspaces.stageFromGit;
        if (!stage) {
            void pickFolder('Where should the clone land? Pick the parent folder', addStart).then((parent) => { if (parent) void resolvedBridge?.workspaces.previewAddFromGit(url, parent).then((p) => { setAddFromGit(false); setAddPreview(p); }); });
            return;
        }
        setAddBusy(true);
        void stage(url)
            .then((r) => { setAddFromGit(false); if (r.ok) setWizardRead(r.existing ? r : { ...r, url }); else setAddPreview(r); }, (e: unknown) => { setAddFromGit(false); setAddPreview({ ok: false, reason: e instanceof Error ? e.message : String(e) }); })
            .finally(() => setAddBusy(false));
    };
    // Import from Git's browser (Add workspace parity item 8): the HOST's GitHub sign-in lists what it reaches, read each
    // time the form opens and on Refresh / Check again. A host without the call keeps the URL box alone.
    const [gitRepos, setGitRepos] = useState<RepoListing | null | undefined>(undefined);
    const loadGitRepos = () => {
        const list = resolvedBridge?.workspaces.githubRepos;
        if (!list) { setGitRepos(undefined); return; }
        setGitRepos(null);
        void list().then(setGitRepos, (e: unknown) => setGitRepos({ status: 'failed', message: e instanceof Error ? e.message : String(e) }));
    };
    const startAddFromGit = () => { setAddOpen(false); setAddPreview(null); setTynnPick(undefined); setAddFromGit(true); loadGitRepos(); };
    const startAddFromTynn = () => {
        setAddOpen(false);
        setAddFromGit(false);
        setAddPreview(null);
        setTynnPick(null);
        void resolvedBridge?.workspaces.tynnProjects().then((r) => setTynnPick(r));
    };
    const workspaceRow = workspaceId ? snapshot.workspaces?.find((w) => w.id === workspaceId) ?? null : null;
    // SHARE THROUGH TYNN (Tynn #839): this Genie's own workspaces only — never from a window driving another host.
    const shares = !remote.state?.connected && typeof window !== 'undefined' ? window.genie?.tynnNetwork?.shares : undefined;
    const [share, setShare] = useState<{ workspaceId: string; name: string; links: ShareLink[] | null; minted: ShareLink | null; problem: string | null; busy: boolean } | null>(null);
    const readShares = (forWorkspace: string) => {
        void shares?.list(forWorkspace).then((r) => setShare((s) => (s && s.workspaceId === forWorkspace ? { ...s, links: r.ok ? r.links : [], problem: r.ok ? s.problem : r.reason } : s)));
    };
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
              // Genie 1's default agent: this workspace's agents, the designated one, and the registry's answer (the snapshot redraws).
              defaultAgent: {
                  agents: snapshot.agents.filter((a) => a.workspaceId === workspaceId).map((a) => ({ id: a.id, name: a.name })),
                  current: workspaceRow.defaultAgentId ?? null,
                  onSet: (agentId) => { void resolvedBridge.workspaces.setDefaultAgent(workspaceId, agentId).then((r) => { if (!r.ok) setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              },
              ...(resolvedBridge.workspaces.importedAgents && resolvedBridge.workspaces.adoptAgent && roster && roster.workspaceId === workspaceId
                  ? {
                        agentRoster: {
                            registered: snapshot.agents.filter((a) => a.workspaceId === workspaceId).map((a) => ({ id: a.id, name: a.name, provider: a.provider })),
                            onDisk: roster.onDisk,
                            busy: roster.busy,
                            notice: roster.notice,
                            error: roster.error,
                            onReattach: (name: string) => {
                                setRoster((s) => (s ? { ...s, busy: name, notice: null, error: null } : s));
                                void resolvedBridge.workspaces.adoptAgent!(workspaceId, name)
                                    .then(
                                        // Name what happened and what it did NOT do.
                                        (r) => setRoster((s) => (s && s.workspaceId === workspaceId ? (r.ok ? { ...s, notice: `${name} is registered. Its .agents/${name}/AGENT.md was read, not rewritten.` } : { ...s, error: r.reason }) : s)),
                                        (e: unknown) => setRoster((s) => (s && s.workspaceId === workspaceId ? { ...s, error: e instanceof Error ? e.message : String(e) } : s)),
                                    )
                                    .finally(() => { setRoster((s) => (s ? { ...s, busy: null } : s)); readRoster(resolvedBridge, workspaceId); });
                            },
                        },
                    }
                  : {}),
              // Its colour (genie#1300): written to its project.json by the host; the snapshot brings the new colour back.
              ...(resolvedBridge.workspaces.setColor
                  ? {
                        color: {
                            current: workspaceRow.color ?? null,
                            onSet: (color: string) => { void resolvedBridge.workspaces.setColor?.(workspaceId, color).then((r) => { if (!r.ok) setWsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
                        },
                    }
                  : {}),
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
              ...(shares ? { onShare: () => { setShare({ workspaceId, name: workspaceLabel(snapshot.workspaces, workspaceId), links: null, minted: null, problem: null, busy: false }); readShares(workspaceId); } } : {}),
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
    /*
     * THE PROVIDER'S MODELS for the agent's picker (the owner, 2026-10-21: "make sure that the model selection for agents
     * is using actual available options from the providers"). Asked when the agent's Settings are on screen — main keeps
     * one answer per provider, so this starts no CLI after the first — and again after a change (the running session's
     * `current` moves) or on Refresh. An older host with no `models` keeps the free-text field.
     */
    const [modelChoices, setModelChoices] = useState<ModelChoices | 'loading' | undefined>(undefined);
    const [modelsAsked, setModelsAsked] = useState(0);
    // A Refresh is ONE ask of the provider again (it starts its CLI), never carried over to the next agent opened.
    const refreshModels = useRef(false);
    const modelsAgent = useRef<string | null>(null);
    const modelsWanted = parsed.surface === 'agent' && parsed.tab === 'settings';
    const modelsProvider = detail?.agent.provider ?? null;
    // Started or stopped: whose answer it is changes (the running session's own, or the provider's CLI's).
    const modelsRunning = detail?.session?.running === true;
    useEffect(() => {
        const agents = resolvedBridge?.agents;
        if (!agents?.models || !agentId || !modelsWanted) { setModelChoices(undefined); return; }
        let live = true;
        const refresh = refreshModels.current;
        refreshModels.current = false;
        // Another agent's list is never shown under this one while its own is asked.
        const sameAgent = modelsAgent.current === agentId;
        modelsAgent.current = agentId;
        setModelChoices((v) => (v === undefined || refresh || !sameAgent ? 'loading' : v));
        void agents.models(agentId, refresh).then(
            (r) => { if (live) setModelChoices('provider' in r ? r : { ok: false, provider: modelsProvider ?? '', reason: r.reason }); },
            (error: unknown) => { if (live) setModelChoices({ ok: false, provider: modelsProvider ?? '', reason: error instanceof Error ? error.message : String(error) }); },
        );
        return () => { live = false; };
    }, [resolvedBridge, agentId, modelsWanted, modelsProvider, modelsRunning, modelsAsked]);
    const agentOps: AgentOpsProps | undefined = resolvedBridge && agentId
        ? {
              deletePreview: opsView.deletePreview,
              diagnosis: opsView.diagnosis,
              lastOutcome: opsView.lastOutcome,
              budgetUsd: detail?.agent.dailyBudgetUsd ?? null,
              mode: detail?.agent.mode ?? 'manual',
              accessScope: detail?.agent.accessScope ?? 'self',
              autoApprove: detail?.agent.autoApprove === true,
              manageTabs: detail?.agent.manageTabs === true,
              drivePages: detail?.agent.drivePages === true,
              ...(detail?.agent.issueWatch ? { issueWatch: detail.agent.issueWatch } : {}),
              permissions: detail?.agent.permissions ?? 'all',
              model: detail?.agent.model ?? null,
              ...(modelChoices !== undefined ? { models: modelChoices } : {}),
              onRefreshModels: () => { refreshModels.current = true; setModelsAsked((n) => n + 1); },
              onSetModel: (model) => { void resolvedBridge.agents.setModel(agentId, model).then((r) => { setOpsView((v) => ({ ...v, lastOutcome: r.ok ? applyOutcome(detail?.agent.name ?? 'the agent', model ?? 'the provider default', r.apply ?? { when: 'next-start' }) : r.reason })); if (r.ok) setModelsAsked((n) => n + 1); }); },
              onSetPermissions: (permissions) => { void resolvedBridge.agents.setPermissions(agentId, permissions).then((r) => setOpsView((v) => ({ ...v, lastOutcome: r.ok ? applyOutcome(detail?.agent.name ?? 'the agent', permissions === 'edits' ? 'edits only' : permissions === 'ask' ? 'asks before shell commands' : 'all tools', r.apply ?? { when: 'next-start' }) : r.reason }))); },
              onSetMode: (mode) => { void resolvedBridge.agents.setMode(agentId, mode).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              onSetAccessScope: (scope) => { void resolvedBridge.agents.setAccessScope(agentId, scope).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              onSetAutoApprove: (on) => { void resolvedBridge.agents.setAutoApprove(agentId, on).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              onSetManageTabs: (on) => { void resolvedBridge.agents.setManageTabs(agentId, on).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              onSetDrivePages: (on) => { void resolvedBridge.agents.setDrivePages(agentId, on).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              onSetIssueWatch: (setting) => { void resolvedBridge.agents.setIssueWatch(agentId, setting).then((r) => { if (!r.ok) setOpsView((v) => ({ ...v, lastOutcome: r.reason })); }); },
              // Restart is the one restart (genie#1238); Restart fresh, from the ⋯ menu, is the other operation.
              onRestart: (kind) => {
                  if (kind === 'graceful') { void restartOne(agentId).then((r) => setOpsView((v) => ({ ...v, lastOutcome: r.ok ? 'restarted on the same conversation' : r.reason }))); return; }
                  void resolvedBridge.agents.restart(agentId, 'fresh').then((r) => setOpsView((v) => ({ ...v, lastOutcome: r.ok ? (r.kind === 'fresh' ? `restarted fresh${r.discarded ? ` — discarded conversation ${r.discarded}` : ''}` : 'restarted on the same conversation') : r.reason })));
              },
              // A switch starts a NEW conversation on the new provider; switchOutcome says so, and names a dropped model.
              onSwitchDriver: (to) => { void resolvedBridge.agents.switchDriver(agentId, to).then((r) => { setOpsView((v) => ({ ...v, lastOutcome: switchOutcome(detail?.agent.name ?? 'the agent', r) })); if (r.ok && !r.noop) setModelsAsked((n) => n + 1); }); },
              onDiagnose: () => { void resolvedBridge.agents.diagnose(agentId).then((r) => setOpsView((v) => (r.ok ? { ...v, diagnosis: r.diagnosis } : { ...v, lastOutcome: r.reason }))); },
              onPreviewDelete: (outcome) => { void resolvedBridge.agents.previewDelete(agentId, outcome, []).then((r) => setOpsView((v) => (r.ok ? { ...v, deletePreview: r.plan } : { ...v, lastOutcome: r.reason }))); },
              onConfirmDelete: (outcome, also, handoff) => {
                  // The handoff wait is bounded (45 s) but not instant: say what is happening while it runs.
                  if (handoff) setOpsView((v) => ({ ...v, lastOutcome: `asking ${detail?.agent.name ?? 'the agent'} for a handoff first — up to 45 s` }));
                  void resolvedBridge.agents.delete(agentId, outcome, also, handoff).then((r) => {
                      if (r.ok) { setOpsView({ deletePreview: null, diagnosis: null, lastOutcome: null }); navigate(DEFAULT_ROUTE); }
                      else setOpsView((v) => ({ ...v, lastOutcome: r.reason }));
                  });
              },
              onCancelDelete: () => setOpsView((v) => ({ ...v, deletePreview: null })),
              onSetBudget: (usd) => { void resolvedBridge.agents.setBudget(agentId, usd).then((r) => setOpsView((v) => ({ ...v, lastOutcome: r.ok ? (r.decision.kind === 'unenforceable' ? r.decision.reason : usd === null ? 'budget cleared' : `budget set to ${usd}/day`) : r.reason }))); },
          }
        : undefined;

    /**
     * The panel pinned to the dock (the file panel, lists) — view state. The chat is not pinned: it is open while the route
     * names it (`chat=`), and an open chat always holds the dock, over whatever is pinned (`dockHolder`; the owner,
     * 2026-10-17: "make the pinned chat be the only chat ux").
     */
    const [pinned, setPinned] = useState<PinnedPanel | null>(null);
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
        // An open chat holds the dock: pinning the file panel takes the slot from it, and the chat closes (one slot).
        const holder = dockHolder(pinned, parsed.chat !== null);
        const outcome = pinPanel(holder === 'files' && filesWorkspaceId !== id ? null : holder, 'files', filesDirty);
        if (outcome.refused !== null) { setDockNotice({ kind: 'refused', reason: outcome.refused, workspaceId: filesWorkspaceId }); return; }
        setPinned(outcome.pinned === 'chat' ? null : outcome.pinned);
        setFilesWorkspaceId(outcome.pinned === 'files' ? id : null);
        if (outcome.replaced !== null) setDockNotice({ kind: 'replaced', replaced: outcome.replaced, pinned: outcome.pinned });
        // A displaced chat must leave the route too, or `chat=` reopens it in the dock on the next navigation.
        const after = routeAfterPin(route, outcome);
        if (after !== route) navigate(after);
    };
    // ⌘B / Ctrl+B toggles the file panel of the workspace on screen (§4.3); ⌘J / Ctrl+J the chat flyout on genie
    // (the board's `Chat ⌘J`). Chords, so they work while typing.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const action = globalAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: isTypingTarget(e.target as never) });
            // The Command Window's key is a remappable binding, handled with the nudge below (Tynn #759).
            if (action === 'open-settings') {
                e.preventDefault();
                navigate('genie://settings');
                return;
            }
            if (action === 'toggle-chat') {
                // The chat cannot close (2026-10-19): its key takes you TO it — the composer, ready to type.
                e.preventDefault();
                document.querySelector<HTMLElement>('[data-chat-composer] [contenteditable="true"], [data-chat-composer] textarea, [data-chat-composer] [role="textbox"]')?.focus({ preventScroll: true });
                return;
            }
            if (action !== 'toggle-files') return;
            if (parsed.surface !== 'workspace') return;
            e.preventDefault();
            navigate(parsed.panel === 'files' ? `genie://workspace/${parsed.workspaceId}` : `genie://workspace/${parsed.workspaceId}?files=`);
        };
        // CAPTURE: Genie's chords are caught before whatever has focus can swallow them (Genie 1's hotkeys rule; CI's
        // real window, 2026-10-17: Ctrl+K never reached a bubbling listener with the chat composer focused).
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [parsed, route]);

    // THE COMPOSER-FOCUS LOG (genie#1235): the composer taking the caret unasked is logged with its cause.
    useComposerFocusLog();

    /**
     * THE ANSWER IN FLIGHT — which agent's, for which approval — and the host's last refusal (`core/approval-answering.ts`).
     * Every surface (the Agent view's card, the chat's card, the Deck's rows, the A/D keys) answers through
     * `answerApproval`, and each card derives its OWN `answering` from this pair, so only the approval being answered
     * refuses a second press. The flight ENDS on the host's reply: `ok` clears it; a refusal clears it AND is said on
     * that approval's card in words.
     *
     * It used to be one window-wide `answering: string | null`, set on every path and cleared by nothing — the comment
     * promised "cleared when the agent's detail changes", and no code did it — so the first approval answered in a window
     * disabled every one after it, for the life of the window (the owner, 2026-10-22: "I have agents trying to do work
     * and ask for approval from me but I can't approve anything because the UI is disabled"). And the host's `ok: false`
     * went nowhere, so a refused press looked exactly like that dead button.
     */
    const [answering, setAnswering] = useState<ApprovalAnswering | null>(null);
    const [approvalRefusal, setApprovalRefusal] = useState<ApprovalRefusal | null>(null);
    const answerApproval = useCallback((agentId: string, optionId: string, note: string, approval: Approval | null) => {
        const key = approvalKey(approval);
        const flight: ApprovalAnswering = { agentId, key, optionId };
        setAnswering(flight);
        setApprovalRefusal(null);
        const sent = resolvedBridge ? resolvedBridge.answerApproval(agentId, optionId, note) : Promise.resolve<{ ok: false; reason: string }>({ ok: false, reason: 'Genie is not connected' });
        void sent.then(
            (r) => { if (!r.ok) setApprovalRefusal({ agentId, key, reason: refusalWords(r) }); },
            // Electron wraps a handler's throw as "Error invoking remote method '<channel>': Error: <reason>".
            (error: unknown) => setApprovalRefusal({ agentId, key, reason: refusalWords({ ok: false, reason: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '') }) }),
        ).finally(() => setAnswering((current) => (current === flight ? null : current)));
    }, [resolvedBridge]);

    // The chat's keys (§4.4, `core/keys.ts`): A / D answer the approval parked in the chat — the letters follow the
    // composer. Never while typing. Esc does not close the docked chat.
    // The chat is always open (on its subject), so its keys work on every page — not only one whose route names `chat=`.
    const chatApprovalHere = chatDetail?.session?.pendingApproval ?? null;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const press = { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: isTypingTarget(e.target as never) };
            const action = chatAction(press, { open: true, approval: chatApprovalHere !== null });
            if (action === null) return;
            const optionId = approvalChoice(chatApprovalHere, action);
            if (!optionId || !chatDetail) return;
            e.preventDefault();
            answerApproval(chatDetail.agent.id, optionId, '', chatApprovalHere);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [chatDetail, chatApprovalHere, answerApproval]);

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
    // the thread as not delivered, and sent by the chat's Restart (genie#1238). Never dropped, never shown as sent.
    const [drafts, setDrafts] = useState<readonly Draft[]>([]);
    const [draftProblems, setDraftProblems] = useState<Readonly<Record<string, string>>>({});
    const draftAction = (id: string, action: Promise<{ ok: boolean; reason?: string }>): void => {
        const problem = (text?: string) => setDraftProblems((p) => { const next = { ...p }; if (text) next[id] = text; else delete next[id]; return next; });
        void action.then((r) => problem(r.ok ? undefined : r.reason ?? 'The draft could not be sent. Try again.'),
            (error: unknown) => problem(error instanceof Error ? error.message : String(error)));
    };
    const [paletteOpen, setPaletteOpen] = useState(false);
    const keepDraft = (agentId: string, text: string, attachments: readonly Attachment[], reason?: string): void => setDrafts((d) => [...d, { id: `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, agentId, text, at: Date.now(), ...(attachments.length > 0 ? { attachments } : {}), ...(reason ? { reason } : {}) }]);
    /**
     * One message to an agent, and what became of it (core/chat-send.ts). The composer hands the outcome to react-fancy
     * (5.70's acknowledged send): a failure stays in the composer, with its reason; an agent not running keeps it here as
     * not delivered, with the chat's Restart (genie#1238). A Take Over window has no session to prompt: its mail goes to
     * its inbox, which its TUI reads over MCP.
     */
    const send = (agentId: string, text: string, attachments: readonly Attachment[] = []): Promise<ChatSendOutcome> => {
        const row = snapshot.agents.find((r) => r.id === agentId);
        return deliverChat(row ? chatSendFor(row) : { kind: 'prompt' }, text, attachments, {
            prompt: resolvedBridge ? (t, files) => resolvedBridge.prompt(agentId, t, files) : null,
            mail: (to, t) => (resolvedBridge?.features ?? NO_FEATURES).act({ kind: 'inbox.send', to, text: t }).then(setFeatures),
            keepUndelivered: () => keepDraft(agentId, text, attachments),
        });
    };
    /**
     * An undelivered draft's button: `Send now` while its agent runs, else THE CHAT'S ONE RESTART (genie#1238). A Restart
     * is the one restart — it works from every state (it used to be a graceful restart for a Broken agent, which always
     * refused, or an `openAgent` that did nothing for one whose run had ended) — and main sends every undelivered message
     * in the agent's record, in order, once. Then this window's own kept drafts to it (prompts refused while it was not
     * running, which never reached the record), in the order written.
     */
    const restartAndSend = (draftId: string): void => {
        if (!resolvedBridge) return;
        const message = chatThread?.messages.find((m) => m.id === draftId);
        const queued = message?.promptId ? message : undefined;
        const draft = drafts.find((d) => d.id === draftId);
        const agentId = queued && chatThread ? chatThread.agentId : draft?.agentId;
        if (!agentId) return;
        const sendKept = (d: Draft): Promise<{ ok: boolean; reason?: string }> =>
            resolvedBridge.prompt(d.agentId, d.text, d.attachments ?? []).then((sent) => { if (sent.ok) setDrafts((all) => all.filter((x) => x.id !== d.id)); return sent; });
        if (message?.resend === 'send') {
            draftAction(draftId, queued ? resolvedBridge.resolvePrompt(agentId, queued.promptId!, 'send') : draft ? sendKept(draft) : Promise.resolve({ ok: true }));
            return;
        }
        const kept = drafts.filter((d) => d.agentId === agentId && !d.reason);
        draftAction(draftId, restartOne(agentId).then(async (r) => {
            if (!r.ok) return r;
            for (const d of kept) {
                const sent = await sendKept(d);
                if (!sent.ok) return { ok: false, reason: sent.reason ?? 'A kept message could not be sent.' };
            }
            return { ok: true };
        }));
    };
    // Derived when its inputs change, not on every render of the window (the owner, 2026-10-20: "severe UI lag"): the
    // thread reads every row of the subject's ledger.
    // FOLLOWING LIVE (the owner, 2026-10-22): an update derives only the lines the chat shows (core/chat-view.ts
    // chatTailStart) — the flyout says how many, and asks for more when the person pages into earlier history.
    const [chatLines, setChatLines] = useState(CHAT_LIVE_LINES);
    // NOT ON EVERY ESTATE SNAPSHOT (genie#1340): the thread reads only the agents' ids, names and fidelity, and the
    // snapshot changes whenever any agent's status does — twenty times a second with eleven at work. Keyed on what it
    // reads, the list it is given changes only when one of those does.
    const agentsKey = chatAgentsKey(snapshot.agents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const chatAgents = useMemo(() => snapshot.agents, [agentsKey]);
    const chatBase = useMemo(() => (chatSubject === null ? null : chatThreadFrom(chatDetail, chatSubject, chatAgents, Date.now, chatLines)), [chatDetail, chatSubject, chatAgents, chatLines]);
    const chatRunning = chatDetail !== null && chatBase !== null && chatDetail.agent.id === chatBase.agentId && chatDetail.session?.running === true;
    const inboxRecent = features.inbox?.recent ?? null;
    // The same thread object until something it shows changed, so the chat does not draw again for nothing.
    const chatDrafts: ChatThread | null = useMemo(() => chatBase === null
        ? null
        : withDrafts(chatBase.fidelity === 'observed' ? { ...chatBase, ...observedMail(inboxRecent, chatBase.agentId, chatBase.name) } : chatBase, drafts, { running: chatRunning }), [chatBase, inboxRecent, drafts, chatRunning]);
    const chatThread: ChatThread | null = useMemo(() => (chatDrafts === null || Object.keys(draftProblems).length === 0 ? chatDrafts : { ...chatDrafts, messages: chatDrafts.messages.map((m) => {
        const problem = draftProblems[m.id];
        return problem ? { ...m, draftProblem: problem } : m;
    }) }), [chatDrafts, draftProblems]);
    const discardDraft = (draftId: string): void => {
        const queued = chatThread?.messages.find((m) => m.id === draftId && m.promptId);
        if (queued && chatThread && resolvedBridge) draftAction(draftId, resolvedBridge.resolvePrompt(chatThread.agentId, queued.promptId!, 'discard'));
        else setDrafts((d) => d.filter((x) => x.id !== draftId));
    };

    // SAVED PROMPTS (Tynn #758): the library from Settings → Agents, sent from the Command Window or by a prompt's own
    // hotkey to the agent in front of the person — its chat if open, else the agent on screen, else Genie — and that chat
    // is opened, so a key press is never a send nobody saw.
    const savedRaw = features.settings.values?.['saved_prompts'];
    const savedPrompts: SavedPrompt[] = parsePromptLibrary(typeof savedRaw === 'string' ? savedRaw : undefined);
    const [promptPlatform, setPromptPlatform] = useState('generic');
    useEffect(() => { setPromptPlatform(detectPlatform(browserPlatformHints()) === 'apple' ? 'darwin' : 'generic'); }, []);
    const sendToAgentInFront = (text: string): void => {
        const to = promptTarget({ chat: chatDetail?.agent.id ?? chatSubject, agentOnScreen: parsed.surface === 'agent' ? parsed.agentId : null });
        // No composer holds a saved prompt: one that fails is kept in the chat as not delivered, with its reason.
        void send(to, text).then((out) => { if (out.kind === 'failed') keepDraft(to, text, [], out.reason); });
        if (parsed.chat !== to) navigate(formatRoute({ ...parsed, chat: to }));
    };
    const sendSavedPrompt = (prompt: SavedPrompt): void => sendToAgentInFront(prompt.text);
    // GENIE'S REMAPPABLE KEYS (Tynn #759): the Command Window (Ctrl/⌘+K) and the ForceTheQuestion nudge (F5) — Genie 1's
    // words to the agent in front of you, for a question it asked in plain text where nobody was looking.
    const bindings = bindingsFrom(features.settings.values);
    // CAPTURE, as Genie's own chords are: these keys are chords or function keys, so they act while typing too.
    // Re-bound every render so it always acts with the current route, bindings and library.
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            // Not in Settings' key recorders — a key pressed there is being assigned.
            if ((e.target as Element | null)?.closest?.('[data-prompt-hotkey], [data-binding]')) return;
            const press = { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: isTypingTarget(e.target as never) };
            const action = hotkeyAction(press, bindings, promptPlatform);
            if (action === 'open-palette') {
                e.preventDefault();
                setPaletteOpen(true);
                return;
            }
            if (paletteOpen) return;
            if (action === 'ftq-nudge') {
                e.preventDefault();
                e.stopPropagation();
                sendToAgentInFront(FTQ_NUDGE_TEXT);
                return;
            }
            const prompt = promptForPress(savedPrompts, press, promptPlatform);
            if (!prompt) return;
            e.preventDefault();
            e.stopPropagation();
            sendSavedPrompt(prompt);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    });

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
        return <TakeOverWindow terminalId={parsed.terminalId} terminals={resolvedBridge?.terminals ?? NO_TERMINALS} login={parsed.login} />;
    }
    // THE FLOW EDITOR IN ITS OWN WINDOW (genie#1204, Genie 1's genie#505): fancy-flow's canvas and nothing else.
    if (parsed.surface === 'flow') {
        return (
            <FlowEditorWindow
                flowId={parsed.flowId}
                workspaceId={parsed.workspaceId}
                data={features}
                workspaces={snapshot.workspaces ?? []}
                act={(action) => (resolvedBridge ? resolvedBridge.features.act(action) : Promise.reject(new Error('This runs inside Genie.')))}
                onSaved={(id) => window.location.replace(`#genie://flow/${encodeURIComponent(id)}`)}
            />
        );
    }
    // THE FILE PANEL IN ITS OWN WINDOW (§4.3): the panel and nothing else; closing the window docks it back.
    if (parsed.surface === 'files') {
        const ws = snapshot.workspaces?.find((w) => w.id === parsed.workspaceId) ?? null;
        return (
            <PluginEditorsContext.Provider value={pluginEditors}>
            <FilesWindow
                workspace={ws}
                loading={snapshot.workspaces === null}
                files={resolvedBridge?.files ?? NO_FILES}
                onBringBack={() => window.close()}
                onPause={(agent: string, path: string, why?: 'conflict') => tellAgent(agent, why === 'conflict' ? conflictMessage(path) : pauseMessage(path))}
                onResume={(agent, path) => tellAgent(agent, resumeMessage(path))}
            />
            </PluginEditorsContext.Provider>
        );
    }

    // THE COMMAND WINDOW (Tynn #757): Genie's things on offer, in Genie 1's order of reach — your saved prompts (#758),
    // the verbs, every workspace, every agent (named with its workspace).
    const paletteActions: Array<{ id: string; label: string; run: () => void }> = [
        { id: 'go-dashboard', label: 'Open the Dashboard', run: () => navigate('genie://dashboard') },
        { id: 'go-deck', label: 'Open the Deck', run: () => navigate('genie://deck') },
        { id: 'go-hosting', label: 'Open Hosting', run: () => navigate('genie://hosting') },
        { id: 'go-settings', label: 'Open Settings', run: () => navigate('genie://settings') },
        { id: 'add-workspace', label: 'Add a workspace…', run: () => previewAdd() },
        // genie#1278 C1: paste a share link, or find my workstations — for the role Tynn gave this machine (none on a drone).
        ...connectPaletteActions(features.remote?.tynnWorkstation?.role ?? null).map((a) => ({ id: a.id, label: a.label, run: () => setConnectDialog(a.id === OPEN_SHARE_LINK_ACTION.id ? 'link' : 'workstations') })),
    ];
    const paletteItems: CommandItem[] = [
        ...promptPaletteItems(savedPrompts, promptPlatform),
        ...paletteActions.map((a) => ({ id: a.id, category: 'action' as const, label: a.label })),
        ...(snapshot.workspaces ?? []).map((w) => ({ id: w.id, category: 'workspace' as const, label: w.name ?? w.id, hint: w.path })),
        ...snapshot.agents.map((a) => {
            const where = (snapshot.workspaces ?? []).find((w) => w.id === a.workspaceId);
            return { id: a.id, category: 'agent' as const, label: a.name, hint: where ? (where.name ?? where.id) : a.provider };
        }),
    ];

    // A remote host's window (Tynn #819) shows its host's Genie or nothing of this machine's: until connected, only its
    // connecting screen — Reconnect, or the PIN when this device is not paired.
    if (remote.bound && !remote.state?.connected) {
        // A Tynn workstation (relay:<id>): its name and the steps, offline said as such, Retry — no host/PIN form, no id.
        // A tailnet host (ws:// / wss://): its host name, with the host/PIN form — that IS its way in.
        const tailnetHost = remote.bound.replace(/^wss?:\/\//, '').replace(/\/genie$/, '');
        return (
            <div data-remote-window={remote.bound} className="flex h-full flex-col items-center justify-center gap-4 bg-[var(--bg-0)] p-8 text-[var(--fg-1)]">
                {relayWorkstationOf(remote.bound) !== null ? (
                    <RelayConnecting name={remote.boundName} state={remote.relayConnect} onRetry={remote.reconnect} />
                ) : (
                    <>
                        <h1 className="text-sm font-semibold">Connecting to {tailnetHost}…</h1>
                        <ConnectRemote state={remote.state} remembered={[remote.bound]} onConnect={(i) => { void remote.connect(i); }} onDisconnect={remote.disconnect} onReconnect={remote.reconnect} upgrade={remote.upgrade} />
                    </>
                )}
            </div>
        );
    }
    return (
        <HostPathPickerContext.Provider value={pickHostPath}>
        <PluginEditorsContext.Provider value={pluginEditors}>
        <PanelHostContext.Provider value={panelHost}>
        <Shell
            pulsingWorkspaces={pulsingIds(pulses)}
            rowEmoji={rowEmoji}
            rateLimits={rateLimits}
            mailSignals={mailSignalList}
            route={route}
            address={shownAddress}
            snapshot={snapshot}
            chatDrafts={keptDrafts}
            workspaceFaults={workspaceFaults}
            onLocateRepo={locateRepo}
            servable={SERVABLE}
            remote={remote.state?.connected && remote.state.host ? { host: remote.state.host, driver: remote.state.driver, driving: remote.state.driving, locked: remote.state.locked } : null}
            remoteConnect={{
                state: remote.state, remembered: remote.remembered, onConnect: remote.connect, onDisconnect: remote.disconnect,
                known: remote.known, onForgetHost: remote.forget, onReconnect: remote.reconnect,
                onUpgradeHost: remote.upgradeHost, upgrade: remote.upgrade,
                // Its own window when this Genie can open one (Genie 1's remote.open); else this window connects.
                onOpenHost: (url: string) => openRemoteHost(url, bridge, typeof window === 'undefined' ? undefined : window.genie, (u) => { void remote.connect({ host: u, pin: '', label: '' }); }),
                // A Tynn workstation (Tynn #837): its own window, bound to relay:<id>.
                tynnWorkstations: remote.tynnWorkstations,
                onOpenWorkstation: (w: TynnWorkstationRow) => openRemoteHost(`relay:${w.id}`, bridge, typeof window === 'undefined' ? undefined : window.genie, (u) => { void remote.connect({ host: u, pin: '', label: '' }); }, w.name),
                onOpenLink: () => setConnectDialog('link'),
                onRefresh: remote.reloadTynnWorkstations,
                refresh: remote.tynnRefresh,
                // genie#1278 W6: only when Tynn says this machine is a pilot; Tynn enforces it again, with the code.
                onSetRole: features.remote?.tynnWorkstation?.role === 'pilot' ? setWorkstationRole : undefined,
            }}
            agentOps={agentOps}
            workspaceOps={workspaceOps}
            addPreview={addPreview}
            addBusy={addBusy}
            onConfirmAdd={(path) => confirmAddOnce(() => resolvedBridge?.workspaces.confirmAdd(path))}
            onCancelAdd={() => setAddPreview(null)}
            agentDetail={detail}
            agentResolved={resolved}
            selectedRowId={selectedRowId}
            chatThread={chatThread}
            onChatWindowLines={setChatLines}
            openedThreads={openedThreads}
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
            // The AgentInbox flyout reads its actions' answers (a thread, an attachment) and a send's refusal.
            featureAsk={(action) => (resolvedBridge?.features ?? NO_FEATURES).act(action).then((data) => { setFeatures(data); return data; })}
            onSend={(id, text, attachments) => (id ? send(id, text, attachments ?? []) : Promise.resolve<ChatSendOutcome>({ kind: 'failed', reason: 'No agent to send to.' }))}
            onRestartAndSend={restartAndSend}
            onDiscardDraft={discardDraft}
            answeringApproval={answering}
            approvalRefusal={approvalRefusal}
            onAnswerApproval={(id, optionId, note, approval) => answerApproval(id, optionId, note ?? '', approval ?? null)}
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
            onAnswerDeckItem={(item, optionId, note) => {
                // The Deck answers for an agent the route is NOT on, so the id comes from the
                // item rather than from the URL — and the item's id says which channel it takes.
                const route = deckAnswerRoute(item, optionId, note ?? '');
                switch (route.kind) {
                    case 'refused':
                        console.error('[genie] deck answer refused:', route.reason);
                        return;
                    case 'feature':
                        void (resolvedBridge?.features ?? NO_FEATURES).act({ kind: 'deck.answer', item, optionId, ...(note ? { note } : {}) }).then(setFeatures).catch((error: unknown) => {
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
                        // A Deck row holds no approval to compare: the flight is keyed on the agent (one parked at a time).
                        answerApproval(route.agentId, optionId, route.note, null);
                        return;
                }
            }}
            onCloseChat={() => {
                // The close button drops the chat from the ROUTE, which is the one place its subject lives.
                const next = route.replace(/[?&]chat=[^&]*/, '').replace(/[?&]pin=[^&]*/, '');
                navigate(next);
            }}
            onChatAgent={(id) => setDashboardChat(id)}
            onOpenAgent={(id) => {
                // Start or reattach, THEN navigate. Reattach is the main process's job and is
                // idempotent, so arriving at an agent that is already running is not a second
                // session — §6.2 is explicit, and the alternative is two provider processes
                // answering as one agent.
                resolvedBridge?.openAgent(id);
                navigate(`genie://agent/${id}?tab=stream`);
            }}
            // Every "+ Add agent" opens the New agent form (Genie 1's); nothing is created until it is filled in.
            onAddAgent={(workspaceId) => setNewAgentFor(workspaceId)}
            onAddWorkspace={previewAdd}
            // The Genie browser window: this machine's sites, or — in a window driving a Tynn workstation — that workstation's.
            onOpenBrowser={resolvedBridge?.browserWindow ? () => { void resolvedBridge.browserWindow?.open(); } : undefined}
            addFromGit={addFromGit}
            onAddWorkspaceFromGit={startAddFromGit}
            onCancelAddGit={() => setAddFromGit(false)}
            onPreviewFromGit={importFromGit}
            gitRepos={gitRepos}
            onReloadGitRepos={loadGitRepos}
            onGitGithub={githubAsk}
            onConfirmAddGit={(url, parent) => confirmAddOnce(() => resolvedBridge?.workspaces.confirmAddFromGit(url, parent))}
            // From Tynn (§6.1, Genie 1's): the person's projects first; the one picked goes to the host's folder picker and its plan.
            tynnPick={tynnPick}
            onAddWorkspaceFromTynn={startAddFromTynn}
            onPickTynnProject={(projectId) => {
                void pickFolder('Where should the Tynn envelope be created? Pick the parent folder', addStart).then((parent) => { if (parent) void resolvedBridge?.workspaces.previewAddFromTynn(projectId, parent).then((p) => { setTynnPick(undefined); setAddPreview(p); }); });
            }}
            onCancelTynnPick={() => setTynnPick(undefined)}
            onConfirmAddTynn={(parent, projectId) => confirmAddOnce(() => resolvedBridge?.workspaces.confirmAddFromTynn(parent, projectId))}
            terminals={resolvedBridge?.terminals ?? NO_TERMINALS}
            files={resolvedBridge?.files}
            // Live site panels — this machine's only (a remote bridge has none).
            sitePanels={resolvedBridge?.sitePanels}
            activity={resolvedBridge?.activity}
            tynnBoard={tynnBoardHost}
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
            // Attachments (§6.4) are the HOST's files, picked over its disk (Tynn #835).
            pickFiles={pickHostPath ? () => pickHostPath({ mode: 'files', title: 'Attach files', initialPath: pickerStart({ workspacePath: workspaceRow?.path ?? null, primaryWorkspace, home: hostHome }) }).then((p) => (Array.isArray(p) ? p : typeof p === 'string' ? [p] : [])) : undefined}
            updates={resolvedBridge?.updates ?? NO_UPDATES}
            windowChrome={resolvedBridge?.windowChrome}
            onTakeOver={(agentId) => { void resolvedBridge?.takeOver(agentId); }}
            // The Dashboard's broken-row Restart and every Start: the one restart (genie#1238). A refusal is logged, never dropped silently.
            onRestartAgent={(agentId) => { void restartOne(agentId).then((r) => { if (!r.ok) console.error('[genie] restart refused:', r.reason); }); }}
            onStopAgent={(agentId) => { resolvedBridge?.stopAgent(agentId); }}
            onCancelTurn={(agentId) => { void resolvedBridge?.cancelTurn(agentId); }}
            onResumeLimit={(agentId) => { void resolvedBridge?.resumeLimit(agentId); }}
            onProviderLogin={(agentId) => { void resolvedBridge?.providerLogin(agentId); }}
            onAccountRetry={(agentId) => { void resolvedBridge?.accountRetry?.(agentId); }}
            onDesignLogin={(agentId) => { void resolvedBridge?.designLogin?.(agentId); }}
            onStartAgent={(agentId) => { void restartOne(agentId).then((r) => { if (!r.ok) console.error('[genie] start refused:', r.reason); }); }}
            onSelectRow={setSelectedRowId}
            // The title bar's "Search, jump, run · Ctrl K" box opens the Command Window (Tynn #757), as Ctrl/Cmd+K does.
            onOpenPalette={() => setPaletteOpen(true)}
        />
        <CommandWindow
            open={paletteOpen}
            items={paletteItems}
            onClose={() => setPaletteOpen(false)}
            onActivate={(item) => {
                if (item.category === 'workspace') navigate(`genie://workspace/${item.id}`);
                else if (item.category === 'agent') navigate(`genie://agent/${item.id}`);
                else if (item.category === 'action') paletteActions.find((a) => a.id === item.id)?.run();
                else if (item.category === 'prompt') { const prompt = savedPrompts.find((p) => p.id === item.id); if (prompt) sendSavedPrompt(prompt); }
            }}
        />
        {/* What's New, once per version (Tynn #762): closing records the version as seen. */}
        {features.whatsNew ? (
            <WhatsNewWindow
                whatsNew={features.whatsNew}
                onClose={() => featureAct({ kind: 'whatsNew.close', version: features.whatsNew!.version }, 'What’s new was not recorded as seen')}
            />
        ) : null}
        {/* ADD A WORKSPACE (Genie 1's modal). Before the picker, so Browse opens on top of it. */}
        <AddWorkspaceModal
            open={addOpen}
            primaryWorkspace={primaryWorkspace}
            sep={hostSep}
            browseParent={(current) => pickFolder('Choose where the workspace should live', pickerStart({ workspacePath: current, primaryWorkspace, home: hostHome }))}
            create={async (name, parent, remote, tynnProjectId) => {
                const create = resolvedBridge?.workspaces.create;
                if (!create) return { ok: false, reason: 'This Genie cannot create a workspace.' };
                return create(name, parent, remote, tynnProjectId);
            }}
            github={features.integrations?.github ?? null}
            onGithub={githubAsk}
            onCreated={(id) => { navigate(`genie://workspace/${id}`); offerAgentsRef.current(id); }}
            onOpenExisting={openExisting}
            onGit={startAddFromGit}
            onTynn={startAddFromTynn}
            tynn={tynnLinkApi}
            onClose={() => setAddOpen(false)}
        />
        {/* OPEN EXISTING / IMPORT FROM GIT — Genie 1's four steps; a NEW workspace beside the source. Before the picker, so Browse opens on top. */}
        <AddWorkspaceWizard
            read={wizardRead}
            primaryWorkspace={primaryWorkspace}
            sep={hostSep}
            browseParent={(current) => pickFolder('Choose where the workspace should live', pickerStart({ workspacePath: current, primaryWorkspace, home: hostHome }))}
            build={async (plan, remote) => {
                const build = resolvedBridge?.workspaces.buildEnvelope;
                if (!build) return { ok: false, reason: 'This Genie cannot build a workspace.' };
                return build(plan, remote);
            }}
            github={features.integrations?.github ?? null}
            onGithub={githubAsk}
            registerExisting={async (path) => {
                const register = resolvedBridge?.workspaces.registerExisting;
                return register ? register(path) : { ok: false, reason: 'This Genie cannot add an existing workspace.' };
            }}
            cloneExisting={async (url, parent) => {
                const r = await resolvedBridge?.workspaces.confirmAddFromGit(url, parent);
                if (!r) return { ok: false, reason: 'This Genie cannot clone a workspace.' };
                return r.ok ? { ok: true, id: r.id } : r;
            }}
            discard={(path) => { void resolvedBridge?.workspaces.discardStaged?.(path); }}
            onAdded={(id) => { setWizardRead(null); navigate(`genie://workspace/${id}`); offerAgentsRef.current(id); }}
            onClose={() => setWizardRead(null)}
            tynn={tynnLinkApi}
        />
        {newAgentFor !== null && resolvedBridge ? (
            <NewAgentModal
                workspaceName={workspaceLabel(snapshot.workspaces, newAgentFor)}
                onCreate={async (input) => {
                    const r = await resolvedBridge.addAgent(newAgentFor, input);
                    if (r.ok) navigate(`genie://agent/${r.id}?tab=settings`);
                    return r.ok ? { ok: true as const } : r;
                }}
                onClose={() => setNewAgentFor(null)}
            />
        ) : null}
        {/* "IT CAME WITH AGENTS" (Add workspace parity item 6): over the workspace an add just opened. */}
        {resolvedBridge?.workspaces.adoptAgent ? (
            <ImportedAgentsModal
                shown={cameWith ? { workspaceId: cameWith.workspaceId, name: workspaceLabel(snapshot.workspaces, cameWith.workspaceId), path: snapshot.workspaces?.find((w) => w.id === cameWith.workspaceId)?.path ?? null, agents: cameWith.agents } : null}
                api={{ adopt: (workspaceId, name) => resolvedBridge.workspaces.adoptAgent!(workspaceId, name) }}
                onClose={() => setCameWith(null)}
            />
        ) : null}
        {pickerAsk && resolvedBridge?.host ? (
            <HostPathPicker
                mode={pickerAsk.opts.mode}
                title={pickerAsk.opts.title}
                initialPath={pickerAsk.opts.initialPath}
                extensions={pickerAsk.opts.extensions}
                listDir={(path) => resolvedBridge.host!.listDir(path)}
                mkdir={resolvedBridge.host.mkdir ? (parent, name) => resolvedBridge.host!.mkdir!(parent, name) : undefined}
                onPick={(p) => { pickerAsk.resolve(p); setPickerAsk(null); }}
                onCancel={() => { pickerAsk.resolve(null); setPickerAsk(null); }}
            />
        ) : null}
        {share && shares ? (
            <ShareWorkspaceModal
                workspaceName={share.name}
                links={share.links}
                minted={share.minted}
                problem={share.problem}
                busy={share.busy}
                onClose={() => setShare(null)}
                onMint={(input) => {
                    const forWorkspace = share.workspaceId;
                    setShare((s) => (s ? { ...s, busy: true, problem: null, minted: null } : s));
                    void shares.mint({ workspaceId: input.whole ? null : forWorkspace, capability: input.capability, expiresInDays: input.expiresInDays }).then((r) => {
                        setShare((s) => (s && s.workspaceId === forWorkspace ? { ...s, busy: false, minted: r.ok ? r.link : null, problem: r.ok ? null : r.reason } : s));
                        if (r.ok) readShares(forWorkspace);
                    });
                }}
                onRevoke={(linkId) => {
                    const forWorkspace = share.workspaceId;
                    setShare((s) => (s ? { ...s, busy: true, problem: null } : s));
                    void shares.revoke(linkId).then((r) => {
                        setShare((s) => (s && s.workspaceId === forWorkspace ? { ...s, busy: false, minted: s.minted?.id === linkId ? null : s.minted, problem: r.ok ? null : r.reason } : s));
                        readShares(forWorkspace);
                    });
                }}
            />
        ) : null}
        {connectDialog ? (
            <ConnectDialog
                key={connectDialog}
                mode={connectDialog}
                onClose={() => setConnectDialog(null)}
                onSwitch={setConnectDialog}
                workstations={remote.tynnWorkstations}
                onOpenWorkstation={(w: TynnWorkstationRow) => openRemoteHost(`relay:${w.id}`, bridge, typeof window === 'undefined' ? undefined : window.genie, (u) => { void remote.connect({ host: u, pin: '', label: '' }); }, w.name)}
                onOpenSurface={() => { setConnectDialog(null); navigate(CONNECT_ROUTE); }}
                openLink={typeof window === 'undefined' ? undefined : window.genie?.tynnNetwork?.openLink}
                refresh={remote.tynnRefresh}
                onRefresh={remote.reloadTynnWorkstations}
            />
        ) : null}
        <AlertToasts toasts={alertToasts} onDismiss={dismissAlert} />
        </PanelHostContext.Provider>
        </PluginEditorsContext.Provider>
        </HostPathPickerContext.Provider>
    );
}
