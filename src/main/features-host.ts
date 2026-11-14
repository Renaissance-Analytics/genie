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
import type { FeatureState } from './feature-ipc.js';
import { REMOTE_ORIGIN } from './host-picks.js';
import type { HostingApi } from './hosting-host.js';
import type { ProcessBookApi } from './processes-host.js';
import type { ProcessScheduler } from './process-scheduler.js';
import type { SupervisorApi } from './process-supervisor.js';
import { applyHostingFeatureAction, hostingFeatureSnapshot, type HostingFeaturePorts, type HostingFeatureServices } from './feature-hosting.js';
import { trustSteps } from './hosting-trust.js';
import { applyMachineFeatureAction, machineFeatureSnapshot, type MachineFeaturePorts, type MachineFeatureServices } from './feature-machine.js';
import { applyToolchainCoreFeatureAction, toolchainSection } from './feature-toolchain.js';

/** Owned machine contributors. Supplying these ports never constructs another service graph. */
export interface HostFeatureMachinePorts {
    readonly services: Omit<MachineFeatureServices, 'settings'>;
    readonly effects: MachineFeaturePorts;
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

/** Owned contributor ports; existing services are supplied, never composed again by the aggregator. */
export interface HostFeaturesPorts {
    readonly settings: Pick<SettingsStore, 'snapshot' | 'get' | 'set' | 'reset' | 'onChange'>;
    readonly knowledge: Pick<KnowledgeStore, 'summaries' | 'search' | 'add' | 'get'>;
    readonly flows: FlowsApi;
    readonly inbox: Pick<InboxStore, 'all' | 'unread' | 'involving' | 'send' | 'receive' | 'attachmentForPerson' | 'deleteThread' | 'onSend' | 'onRead'>;
    readonly attention: Pick<AttentionStore, 'asked'>;
    readonly roster: () => readonly AgentRecord[];
    readonly resolveAddress: (address: string) => Resolution;
    readonly mailRefusal: (address: string) => string | null;
    readonly workspaceIds: () => readonly string[];
    readonly runFlow: (id: string) => Promise<unknown>;
    readonly refreshPlugins: () => Promise<void>;
    readonly applyRemote: () => Promise<void>;
    readonly hosting?: HostFeatureHostingPorts;
    readonly machine?: HostFeatureMachinePorts;
}

const emptyState = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

/**
 * Incremental host aggregator (Tynn #720). Measured groups use owned services and shared business rules.
 * Production composition follows the remaining measured groups; this does not open another store or scheduler.
 */
export class HostFeatures {
    readonly #services: PersonalFeatureServices;
    readonly #hosting: HostingFeatureServices | undefined;
    readonly #hostingPorts: HostingFeaturePorts;
    readonly #machine: MachineFeatureServices | undefined;
    readonly #callers = new Map<string, FeatureState>();
    readonly #listeners = new Set<(data: FeatureData) => void>();
    readonly #offs: Array<() => void>;
    readonly #push: LatestPush<FeatureData>;
    #seq = 0;
    #closed = false;

    constructor(readonly ports: HostFeaturesPorts) {
        this.#services = {
            settings: ports.settings, knowledge: ports.knowledge, flows: ports.flows, inbox: ports.inbox, attention: ports.attention,
            agentAddresses: () => ports.roster().map(record => ({ address: agentAddress(record, new Map()), agentId: record.id, name: record.name })),
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
        return this.#snapshot(this.#callers.get(context.connectionId) ?? emptyState());
    }

    async act(action: FeatureAction, context: CallContext): Promise<FeatureData> {
        this.#check(context);
        const state = this.#callers.get(context.connectionId) ?? emptyState();
        const next = { ...state };
        const handled = await applyPersonalFeatureAction(this.#services, action, state, next,
            { remoteAccess: { apply: () => this.ports.applyRemote() } }, REMOTE_ORIGIN)
            || (this.#hosting ? await applyHostingFeatureAction(this.#hosting, action, state, next, this.#hostingPorts) : false)
            || (this.#machine ? await applyMachineFeatureAction(this.#machine, action, state, next, this.ports.machine!.effects) : false)
            || (this.#hosting && this.ports.machine ? await applyToolchainCoreFeatureAction(this.#hosting, action, state, next, this.ports.machine.effects) : false);
        if (!handled) {
            throw new Error(`the host feature service does not answer ${action.kind} yet`);
        }
        const answer = await this.#snapshot(next);
        // These are replies to the action that requested them, never the next read or a broadcast.
        const { inboxThread: _thread, inboxSearch: _search, servedAttachment: _attachment,
            servedQuestion: _question, flowSaved: _saved, ...retained } = next;
        this.#callers.set(context.connectionId, retained);
        // Knowledge has no store change signal. The other owned stores already invalidate once per change.
        if (action.kind === 'knowledge.add' || action.kind === 'knowledge.create') this.#changed();
        return answer;
    }

    soundData(key: string): Promise<string | null> { return customSoundData(this.ports.settings, key); }

    onChange(listener: (data: FeatureData) => void): () => void {
        if (this.#closed) throw new Error('the host feature service is closed');
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    close(): void {
        this.#closed = true;
        for (const off of this.#offs.splice(0)) off();
        this.#listeners.clear(); this.#callers.clear();
    }

    #check(context: CallContext): void {
        if (this.#closed) throw new Error('the host feature service is closed');
        if (!context.connectionId) throw new Error('features need an admitted caller');
    }

    #changed(): void { if (!this.#closed && this.#listeners.size > 0) this.#push.request(); }

    async #snapshot(state: FeatureState): Promise<FeatureData> {
        const seq = ++this.#seq;
        const personal = await personalFeatureSnapshot(this.#services, state);
        const hosting = this.#hosting ? await hostingFeatureSnapshot(this.#hosting, state, this.#hostingPorts)
            : { hosting: null, services: null, browser: { url: null, routes: [], canGoBack: false, canGoForward: false } };
        const machine = this.#machine ? machineFeatureSnapshot(this.#machine, state, this.ports.machine!.effects)
            : { remote: null, integrations: null, plugins: null, issueWatch: null };
        return { seq, ...personal, ...hosting, ...machine, toolchain: toolchainSection(state) };
    }
}
