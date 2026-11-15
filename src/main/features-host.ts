import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentRecord } from '../core/identity.js';
import { agentAddress } from '../core/inbox.js';
import { LatestPush } from '../core/latest-push.js';
import type { Resolution } from '../core/inbox.js';
import type { CallContext } from '../core/remote-protocol.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';
import type { AttentionStore } from './attention-store.js';
import type { FlowsApi } from './flows-host.js';
import type { InboxStore } from './inbox-store.js';
import type { KnowledgeStore } from './knowledge-store.js';
import type { SettingsStore } from './settings-store.js';
import { applyPersonalFeatureAction, customSoundData, personalFeatureSnapshot, type PersonalFeatureServices } from './feature-personal.js';
import type { FeaturePorts, FeatureState } from './feature-ipc.js';
import type { DeckItem } from '../core/deck.js';
import { deckRefusalLine } from '../core/deck-refusal.js';
import type { DeckAnswerPorts } from './deck-answer.js';
import { MAIN_ERROR_DECK_PREFIX } from '../core/main-errors.js';
import { applyDeckFeatureAction } from './feature-deck.js';
import { applyFeatureControlAction } from './feature-controls.js';
import { featureOriginOf, HostPicks } from './host-picks.js';
import type { HostingApi } from './hosting-host.js';
import type { ProcessBookApi } from './processes-host.js';
import type { ProcessScheduler } from './process-scheduler.js';
import type { SupervisorApi } from './process-supervisor.js';
import { applyHostingFeatureAction, hostingFeatureSnapshot, type HostingFeaturePorts, type HostingFeatureServices } from './feature-hosting.js';
import { trustSteps } from './hosting-trust.js';
import { applyMachineFeatureAction, machineFeatureSnapshot, type MachineFeaturePorts, type MachineFeatureServices } from './feature-machine.js';
import { applyToolchainCoreFeatureAction, toolchainSection, type ToolchainCheckControl } from './feature-toolchain.js';

/** Owned machine contributors. Supplying these ports never constructs another service graph. */
export interface HostFeatureMachinePorts {
    readonly services: Omit<MachineFeatureServices, 'settings'>;
    readonly effects: MachineFeaturePorts;
    readonly effectsFor?: (context: CallContext) => MachineFeaturePorts;
    readonly onChange: (listener: () => void) => () => void;
}

/** The canonical host dependencies for service/site/process reads and actions. */
export interface HostFeatureHostingPorts {
    readonly api: Pick<HostingApi, 'sites' | 'envelopeSites' | 'engines' | 'routes' | 'trust' | 'engineStatuses'
        | 'startEngine' | 'stopEngine' | 'removeEngine' | 'engineDependents' | 'updateEngine' | 'hostingProblems'
        | 'externalFrontDoor' | 'onFrontDoorChange' | 'syncHosts' | 'retryFrontDoor' | 'trustCertificate'>;
    readonly supervisor: SupervisorApi;
    readonly processes: ProcessBookApi;
    readonly processScheduler: Pick<ProcessScheduler, 'runNow'>;
    readonly workspaceVisible: (workspaceId: string) => boolean;
    readonly engineStatusWaitMs?: number;
}

/** Only effects in the admitted caller's own window. Resolution never chooses another window. */
export interface HostFeaturePresentation extends Pick<FeaturePorts, 'rendererNotice' | 'mainErrors' | 'openInBrowser'> {
    readonly openFlowEditor?: (route: string) => void | Promise<void>;
    readonly openExternal?: (url: string) => Promise<void>;
    readonly browser?: {
        snapshot(): { url: string | null; canGoBack: boolean; canGoForward: boolean };
        navigate(url: string): Promise<void>;
        back(): void | Promise<void>;
        forward(): void | Promise<void>;
        reload(): void | Promise<void>;
    };
    readonly login?: (provider: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly githubOpen?: NonNullable<FeaturePorts['githubAccount']>['openPage'];
    readonly tailscaleInstall?: NonNullable<FeaturePorts['tailscale']>['install'];
}

/** Canonical Deck owners, supplied once; UI-only error effects are resolved separately for the caller. */
export interface HostFeatureDeckPorts extends Omit<DeckAnswerPorts, 'mainErrors'> {
    readonly attention: DeckAnswerPorts['attention'] & Pick<AttentionStore, 'dismiss' | 'dismissMany' | 'dismissOlderThan'>;
    deckItems(): readonly DeckItem[];
}

/** Owned contributor ports; existing services are supplied, never composed again by the aggregator. */
export interface HostFeaturesPorts {
    readonly settings: Pick<SettingsStore, 'snapshot' | 'get' | 'set' | 'reset' | 'onChange'>;
    readonly knowledge: Pick<KnowledgeStore, 'summaries' | 'search' | 'add' | 'get'>;
    readonly flows: FlowsApi;
    readonly inbox: Pick<InboxStore, 'all' | 'unread' | 'involving' | 'send' | 'receive' | 'attachmentForPerson' | 'deleteThread' | 'onSend' | 'onRead'>;
    readonly attention: Pick<AttentionStore, 'asked'>;
    readonly roster: () => readonly AgentRecord[];
    readonly workspaceSlugs?: () => ReadonlyMap<string, string>;
    readonly slowPart?: FeaturePorts['slowPart'];
    readonly lifecycleLog?: (line: string) => void;
    readonly resolveAddress: (address: string) => Resolution;
    readonly mailRefusal: (address: string) => string | null;
    readonly workspaceIds: () => readonly string[];
    readonly runFlow: (id: string) => Promise<unknown>;
    readonly refreshPlugins: () => Promise<void>;
    readonly applyRemote: () => Promise<void>;
    readonly hosting?: HostFeatureHostingPorts;
    readonly machine?: HostFeatureMachinePorts;
    /** Resolved by trusted composition for this admitted connection only; no newest-window fallback. */
    readonly presentation?: (context: CallContext) => HostFeaturePresentation | null;
    readonly system?: Pick<FeaturePorts, 'safeMode' | 'hangNotice'>;
    readonly deck?: HostFeatureDeckPorts;
}

const emptyState = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

/** Caller view caches are disposable; durable business state stays in its owned service. */
export const HOST_FEATURE_CALLER_LIMIT = 64;
const CALLER_PENDING_LIMIT = 32;

interface FeatureCaller {
    state: FeatureState;
    picks: HostPicks;
    tail: Promise<void>;
    pending: number;
    live: boolean;
}

/**
 * The host aggregator (Tynn #720), over owned services and shared business rules.
 * Caller views are transient; this opens no store or scheduler of its own.
 */
export class HostFeatures {
    readonly #services: PersonalFeatureServices;
    readonly #hosting: HostingFeatureServices | undefined;
    readonly #hostingPorts: HostingFeaturePorts;
    readonly #machine: MachineFeatureServices | undefined;
    readonly #callers = new Map<string, FeatureCaller>();
    readonly #listeners = new Set<(data: FeatureData) => void>();
    readonly #offs: Array<() => void>;
    readonly #push: LatestPush<FeatureData>;
    readonly #repairingCli = new Set<string>();
    /** Tynn #714: the "Check for updates" run's control (Stop reaches the run through it) and its live rows, pushed as it moves. */
    readonly #checkControl: ToolchainCheckControl = { running: false, stop: false };
    readonly #checkRuns = new Map<symbol, NonNullable<FeatureState['toolchainCheckRun']>>();
    readonly #work = new Map<symbol, NonNullable<FeatureState['toolchainUpdating']>>();
    #toolFacts: Pick<FeatureState, 'toolStatuses' | 'toolchainCheckedAt'> = { toolStatuses: null };
    #progressProbe: Promise<void> | null = null;
    #seq = 0;
    #closed = false;
    readonly #busy = new Map<symbol, string>();
    readonly #activeWork = new Set<symbol>();
    readonly #progressContext = new AsyncLocalStorage<symbol>();

    constructor(readonly ports: HostFeaturesPorts) {
        this.#services = {
            settings: ports.settings, knowledge: ports.knowledge, flows: ports.flows, inbox: ports.inbox, attention: ports.attention,
            agentAddresses: () => ports.roster().map(record => ({ address: agentAddress(record, ports.workspaceSlugs?.() ?? new Map()), agentId: record.id, name: record.name })),
            resolveAddress: address => ports.resolveAddress(address), mailRefusal: address => ports.mailRefusal(address),
            workspaceIds: () => ports.workspaceIds(), flowScheduler: { runNow: id => ports.runFlow(id) },
            pluginsRefresh: () => ports.refreshPlugins(),
        };
        const h = ports.hosting;
        this.#hosting = h ? {
            sites: h.api.sites, engines: h.api.engines, envelopeSites: h.api.envelopeSites, supervisor: h.supervisor,
            routes: () => h.api.routes(), engineStatuses: () => h.api.engineStatuses(),
            startEngine: id => h.api.startEngine(id), stopEngine: id => h.api.stopEngine(id),
            removeEngine: (id, options) => h.api.removeEngine(id, options),
            engineDependents: id => h.api.engineDependents(id), updateEngine: (id, options) => h.api.updateEngine(id, options),
            trustSteps: () => trustSteps(h.api.trust.entries()), workspaceVisible: id => h.workspaceVisible(id),
            get externalFrontDoor() { return h.api.externalFrontDoor; }, hostingProblems: () => h.api.hostingProblems(),
            trustCertificate: () => h.api.trustCertificate(), syncHosts: () => h.api.syncHosts(), retryFrontDoor: () => h.api.retryFrontDoor(),
        } : undefined;
        this.#hostingPorts = h ? { processes: h.processes, processScheduler: h.processScheduler,
            engineStatusWaitMs: h.engineStatusWaitMs, onEngineStatusesLate: () => this.#changed() } : {};
        const m = ports.machine;
        this.#machine = m ? {
            settings: ports.settings, remote: m.services.remote, pairing: m.services.pairing,
            plugins: m.services.plugins, pluginsDir: m.services.pluginsDir, workspaceTrust: m.services.workspaceTrust,
            catalogDefinitions: () => m.services.catalogDefinitions(), integrations: () => m.services.integrations(),
            syncAgentDocs: (...args) => m.services.syncAgentDocs(...args), syncConfig: (...args) => m.services.syncConfig(...args),
        } : undefined;
        // Invalidations carry facts, never a caller's query, form or action-only answer.
        this.#push = new LatestPush({ build: () => this.#snapshot(emptyState()), deliver: data => {
            if (!this.#closed) for (const listener of this.#listeners) listener(data);
        } });
        const changed = () => this.#changed();
        this.#offs = [ports.settings.onChange(changed), ports.flows.onChange(changed), ports.inbox.onSend(changed), ports.inbox.onRead(changed)];
        if (h) this.#offs.push(h.api.engines.onChange(changed), h.api.sites.onChange(changed), h.processes.onChange(changed),
            h.supervisor.onChange(changed), h.supervisor.onOutput(changed), h.api.onFrontDoorChange(changed), h.api.trust.onVerdict(changed));
        if (m) this.#offs.push(m.onChange(changed));
    }

    async snapshot(context: CallContext): Promise<FeatureData> {
        this.#check(context);
        const caller = this.#touch(context.connectionId);
        const answer = await this.#snapshot(caller?.state ?? emptyState(), context);
        this.#check(context);
        return answer;
    }

    async act(action: FeatureAction, context: CallContext): Promise<FeatureData> {
        try {
            this.#check(context);
            const caller = this.#caller(context.connectionId);
            if (caller.pending >= CALLER_PENDING_LIMIT) throw new Error('this feature caller has too many pending actions; wait for them to finish');
            caller.pending++;
            // Same-caller actions see the last committed view, including after a refusal. Other callers never wait here.
            // A Stop cannot queue behind the run it stops: it is answered at once, outside the caller's queue.
            if (action.kind === 'toolchain.stopCheck') return await this.#act(action, context, caller);
            const work = caller.tail.then(async () => {
                try {
                    this.#check(context);
                    if (!caller.live) throw new Error('this feature caller disconnected before its action began');
                    return await this.#act(action, context, caller);
                } finally { caller.pending--; }
            });
            caller.tail = work.then(() => {}, () => {});
            return await work;
        } catch (error) {
            if (action.kind.startsWith('deck.')) this.ports.lifecycleLog?.(deckRefusalLine(action, error));
            throw error;
        }
    }

    #act(action: FeatureAction, context: CallContext, caller: FeatureCaller): Promise<FeatureData> {
        const token = Symbol('feature work');
        this.#activeWork.add(token);
        return this.#progressContext.run(token, () => this.#actInContext(action, context, caller, token)).finally(() => { this.#activeWork.delete(token); });
    }

    async #actInContext(action: FeatureAction, context: CallContext, caller: FeatureCaller, token: symbol): Promise<FeatureData> {
        const state = this.#toolFacts.toolStatuses === null ? caller.state : { ...caller.state, ...this.#toolFacts };
        const next = { ...state };
        const ui = this.#presentation(context, needsPresentation(action));
        if (action.kind.startsWith('browser.') && !ui?.browser) throw new Error(OWN_WINDOW);
        if (action.kind === 'remote.answerPair' && context.origin !== 'local-window') {
            throw new Error('a device is allowed on this machine’s own screen, never from another device');
        }
        const machine = this.ports.machine?.effectsFor?.(context) ?? this.ports.machine?.effects;
        const tc = machine?.toolchain;
        const effects: MachineFeaturePorts = { ...machine, ...(tc ? { toolchain: { ...tc,
            login: async provider => ui?.login ? ui.login(provider) : { ok: false, reason: 'no login is wired into this Genie' },
            checking: run => {
                if (this.#closed) return;
                if (run) this.#checkRuns.set(token, run); else this.#checkRuns.delete(token);
                this.#changed();
                tc.checking?.(run);
            },
            updating: row => {
                if (!this.#closed) {
                    if (row) this.#work.set(token, row); else this.#work.delete(token);
                    this.#changed();
                    tc.updating?.(row);
                }
            },
        } } : {}) };
        const deck = this.ports.deck;
        try {
            const handled = await applyPersonalFeatureAction(this.#services, action, state, next,
                { remoteAccess: { apply: () => this.ports.applyRemote() }, ...(ui?.openFlowEditor ? { openFlowEditor: route => ui.openFlowEditor!(route) } : {}) },
                featureOriginOf(context, caller.picks))
                || (this.#hosting ? await applyHostingFeatureAction(this.#hosting, action, state, next,
                    { ...this.#hostingPorts, ...(ui?.openInBrowser ? { openInBrowser: url => ui.openInBrowser!(url) } : {}) }) : false)
                || (this.#machine ? await applyMachineFeatureAction(this.#machine, action, state, next, effects) : false)
                || (this.#hosting ? await applyToolchainCoreFeatureAction(this.#hosting, action, state, next, effects, this.#repairingCli, this.#checkControl) : false)
                || (deck ? await applyDeckFeatureAction({ ...deck, ...(ui?.mainErrors ? { mainErrors: ui.mainErrors } : {}) }, action) : false)
                || await applyFeatureControlAction({ ...(this.#machine ? { pairing: this.#machine.pairing } : {}), routes: () => this.#hosting?.routes() ?? [] }, action, next,
                    { ...effects, ...this.ports.system, ...(ui?.rendererNotice ? { rendererNotice: ui.rendererNotice } : {}),
                        ...(ui?.browser ? { browser: ui.browser } : {}),
                        githubOpen: async target => { if (!ui?.githubOpen) throw new Error(OWN_WINDOW); await ui.githubOpen(target); },
                        ...(action.kind === 'tailscale.install' ? { tailscale: {
                            install: async () => { if (!ui?.tailscaleInstall) throw new Error(OWN_WINDOW); return ui.tailscaleInstall(); },
                        } } : {}),
                    });
            if (!handled) throw new Error(`the host feature service does not answer ${action.kind} yet`);
        } finally {
            const changedWork = this.#work.delete(token);
            const changedRun = this.#checkRuns.delete(token);
            const changed = changedWork || changedRun;
            if (this.#busy.delete(token) || changed) this.#changed();
        }
        this.#check(context);
        if (action.kind.startsWith('toolchain.') && next.toolStatuses !== null) {
            this.#toolFacts = { toolStatuses: next.toolStatuses, toolchainCheckedAt: next.toolchainCheckedAt ?? null };
            this.#changed();
        }
        const answer = await this.#snapshot(next, context);
        this.#check(context);
        // These are replies to the action that requested them, never the next read or a broadcast.
        const { inboxThread: _thread, inboxSearch: _search, servedAttachment: _attachment,
            servedQuestion: _question, flowSaved: _saved, ...retained } = next;
        // A completed business operation may answer, but can never recreate a view released while it waited.
        if (caller.live) caller.state = retained;
        // Knowledge and the file-health report have no store change signal. Other owned stores invalidate themselves.
        if (action.kind === 'knowledge.add' || action.kind === 'knowledge.create' || action.kind === 'workspace.syncAgentFiles' || action.kind === 'workspace.trust') this.#changed();
        return answer;
    }

    soundData(key: string): Promise<string | null> { return customSoundData(this.ports.settings, key); }

    picked(paths: readonly unknown[], context: CallContext): void {
        this.#check(context);
        if (context.origin === 'local-window') this.#caller(context.connectionId).picks.record(paths);
    }

    releaseCaller(context: CallContext): void {
        this.#release(context.connectionId);
    }

    #release(connectionId: string): void {
        const caller = this.#callers.get(connectionId);
        if (caller) {
            caller.live = false; caller.state = emptyState(); caller.picks = new HostPicks();
            this.#callers.delete(connectionId);
        }
    }

    onChange(listener: (data: FeatureData) => void): () => void {
        if (this.#closed) throw new Error('the host feature service is closed');
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    close(): void {
        this.#closed = true;
        for (const off of this.#offs.splice(0)) off();
        for (const connectionId of this.#callers.keys()) this.#release(connectionId);
        this.#listeners.clear(); this.#callers.clear();
        this.#work.clear(); this.#checkRuns.clear(); this.#busy.clear(); this.#activeWork.clear(); this.#repairingCli.clear();
    }

    #check(context: CallContext): void {
        if (this.#closed) throw new Error('the host feature service is closed');
        if (!context.connectionId) throw new Error('features need an admitted caller');
    }

    #touch(connectionId: string): FeatureCaller | undefined {
        const caller = this.#callers.get(connectionId);
        if (caller) { this.#callers.delete(connectionId); this.#callers.set(connectionId, caller); }
        return caller;
    }

    #caller(connectionId: string): FeatureCaller {
        const previous = this.#touch(connectionId);
        if (previous) return previous;
        if (this.#callers.size >= HOST_FEATURE_CALLER_LIMIT) {
            const oldest = [...this.#callers].find(([, caller]) => caller.pending === 0);
            if (!oldest) throw new Error('feature callers are busy; try again when an action finishes');
            this.#release(oldest[0]);
        }
        const caller: FeatureCaller = { state: emptyState(), picks: new HostPicks(), tail: Promise.resolve(), pending: 0, live: true };
        this.#callers.set(connectionId, caller);
        return caller;
    }

    busy(step: string | null): void { const token = this.#progressContext.getStore(); if (this.#closed || !token || !this.#activeWork.has(token)) return; if (step) this.#busy.set(token, step); else this.#busy.delete(token); this.#changed(); }

    invalidate(): void { this.#changed(); }

    #changed(): void { if (!this.#closed && this.#listeners.size > 0) this.#push.request(); }

    #presentation(context: CallContext, required = false): HostFeaturePresentation | undefined {
        const ui = context.origin === 'local-window' ? this.ports.presentation?.(context) ?? undefined : undefined;
        if (required && !ui) throw new Error(OWN_WINDOW);
        return ui;
    }

    async #snapshot(state: FeatureState, context?: CallContext): Promise<FeatureData> {
        const seq = ++this.#seq;
        const measured = async <T>(part: string, work: () => T | Promise<T>): Promise<T> => {
            const start = Date.now(); try { return await work(); } finally {
                const ms = Date.now() - start; if (this.ports.slowPart && ms >= this.ports.slowPart.ms) this.ports.slowPart.log(part, ms);
            }
        };
        const personal = await measured('knowledge/inbox/flows', () => personalFeatureSnapshot(this.#services, state));
        const hosting = this.#hosting ? await measured('hosting/services', () => hostingFeatureSnapshot(this.#hosting!, state, this.#hostingPorts))
            : { hosting: null, services: null, browser: { url: null, routes: [], canGoBack: false, canGoForward: false } };
        const machine = this.#machine ? machineFeatureSnapshot(this.#machine, state, this.ports.machine!.effects)
            : { remote: null, integrations: null, plugins: null, issueWatch: null };
        // A first repair can start before a scan. Read the owner's actual tools for its live row, never invent an empty scan.
        if ((this.#work.size > 0 || this.#busy.size > 0) && this.#toolFacts.toolStatuses === null && this.ports.machine?.effects.toolchain) {
            const tc = this.ports.machine.effects.toolchain;
            this.#progressProbe ??= tc.probe().then(tools => {
                if (!this.#closed && this.#toolFacts.toolStatuses === null) this.#toolFacts = { toolStatuses: tools, toolchainCheckedAt: tc.now() };
            }).finally(() => { this.#progressProbe = null; });
            await this.#progressProbe;
        }
        const toolchain = toolchainSection({ ...state, toolchainBusy: [...this.#busy.values()].at(-1) ?? state.toolchainBusy ?? null, toolStatuses: this.#toolFacts.toolStatuses ?? state.toolStatuses,
            toolchainCheckedAt: this.#toolFacts.toolchainCheckedAt ?? state.toolchainCheckedAt ?? null,
            toolchainUpdating: [...this.#work.values()].at(-1) ?? null,
            toolchainCheckRun: [...this.#checkRuns.values()].at(-1) ?? state.toolchainCheckRun ?? null });
        const browser = context ? this.#presentation(context)?.browser?.snapshot() : undefined;
        return { seq, ...personal, ...hosting, ...machine, ...(browser ? { browser: { ...hosting.browser, ...browser } } : {}), toolchain };
    }
}

const OWN_WINDOW = 'this feature action needs its caller’s own admitted local window; open Genie there and try again';
function needsPresentation(action: FeatureAction): boolean {
    // Site opening keeps the shared hosting handler's canonical no-browser refusal; it receives only this caller's port.
    return action.kind === 'flows.openEditor' || action.kind === 'flows.newFlow'
        || action.kind.startsWith('browser.') || action.kind === 'rendererNotice.dismiss' || action.kind === 'toolchain.login'
        || action.kind === 'integrations.githubOpen' || action.kind === 'tailscale.install'
        || ((action.kind === 'deck.answer' || action.kind === 'deck.answerForm') && action.item.source === 'genie' && action.item.id.startsWith(MAIN_ERROR_DECK_PREFIX));
}
