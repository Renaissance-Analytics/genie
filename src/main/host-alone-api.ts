import type { AgentId } from '../core/identity.js';
import type { RemoteMethod } from '../core/remote-protocol.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';
import { agentDetailFor } from './agent-detail.js';
import { restartAgent, type AgentRestartPorts } from './agent-ops-host.js';
import type { Finished } from './attention-store.js';
import { answerDeck, type DeckAnswerPorts } from './deck-answer.js';
import { buildHostApi, type HostApiDeps } from './host-api.js';
import type { InboxMessage } from './inbox-store.js';
import type { Registry } from './registry.js';
import type { HostApi } from './remote-host.js';
import type { SessionHost } from './session-host.js';
import { startForWork, startForYourMessage } from './start-on-demand.js';

/**
 * THE PHONE'S METHODS, ANSWERED BY GENIE-HOST WITH EVERY WINDOW CLOSED (Tynn #551, host split P5d.2).
 *
 * genie-host runs the SAME host API a window does (host-api.ts `buildHostApi`), over what genie-host owns: a registry on
 * its own registry store, its session host, its attention, inbox and approval stores, the workspaces' files. So what a
 * phone asks is parsed, gated and answered exactly as a window would; the agent detail and the Deck answer are the
 * window's own builders (agent-detail.ts, deck-answer.ts). Its events (the snapshot, an agent's detail, coalesced as the
 * window's) come from the same code.
 *
 * The remote host uses this only for the phone's methods, and only while no window is connected (remote-access-host.ts):
 * with a window open, the window answers as before. Anything outside the phone's set is refused with what to do.
 */
export const PHONE_METHODS: ReadonlySet<RemoteMethod> = new Set<RemoteMethod>([
    'snapshot', 'agentDetail', 'prompt', 'answerApproval', 'restartWithHandoff', 'agents.restart', 'resumeLimit', 'features.act',
    'files.children', 'files.open', 'files.readMedia', 'files.upload',
]);

/** genie-host's session host, as this API drives it. */
export type HostAloneEngine = Pick<SessionHost,
    'probe' | 'start' | 'stop' | 'ended' | 'deliverOwed' | 'cancel' | 'resumeLimit' | 'prompt' | 'promptWith' | 'resolvePrompt' | 'answerApproval'
    | 'subscribe' | 'needsNewDriver' | 'notice' | 'ledgerFor' | 'turnsFor' | 'recentStderrFor' | 'rowsFor' | 'refusals'>;

export interface HostAlonePorts {
    readonly hostName: string;
    /** A registry over genie-host's own registry store: the snapshot, the records, the restarts' writes. */
    readonly registry: Registry;
    readonly engine: () => HostAloneEngine | null;
    readonly cwdFor: HostApiDeps['cwdFor'];
    /** Why a start would be refused (an asleep workspace, the agent cap), as Start always obeys. */
    readonly startRefusal: AgentRestartPorts['startRefusal'];
    readonly attention: DeckAnswerPorts['attention'] & { finished(): readonly Finished[] };
    readonly approvals: DeckAnswerPorts['approvals'];
    readonly inbox: DeckAnswerPorts['inbox'] & { involving(id: AgentId, limit: number): readonly InboxMessage[] };
    /** An approval's note, delivered to the agent as your message. */
    readonly deliverToAgent: (agentId: string, text: string) => boolean | Promise<boolean>;
    readonly files: NonNullable<HostApiDeps['files']>;
    readonly updates?: HostApiDeps['updates'];
    readonly schedule?: HostApiDeps['schedule'];
}

export function hostAloneApi(ports: HostAlonePorts): HostApi {
    const { hostName, registry } = ports;
    const needsWindow = (what: string) => `${hostName} answers ${what} only while a Genie window is open there: open Genie on ${hostName}`;
    /** A dependency only a window has: every member refuses, except the subscriptions given (which the events wire up). */
    const windowOnly = <T extends object>(what: string, given: Partial<T> = {}): T => new Proxy(given, {
        get: (target, key) => (key in target ? (target as Record<string | symbol, unknown>)[key] : typeof key === 'string' ? () => { throw new Error(needsWindow(`${what}.${key}`)); } : undefined),
    }) as T;
    const engine = (): HostAloneEngine => {
        const e = ports.engine();
        if (!e) throw new Error(`Genie’s agents on ${hostName} are still starting; try again in a moment`);
        return e;
    };
    const restartPorts: AgentRestartPorts = {
        registry: { find: (id) => registry.find(id as AgentId), clearThread: (id) => registry.clearThread(id) },
        host: {
            start: (record, cwd) => engine().start(record, cwd),
            stop: (id) => engine().stop(id),
            ended: (id) => engine().ended(id),
            probe: (id) => ports.engine()?.probe(id) ?? null,
            deliverOwed: (id, then) => engine().deliverOwed(id, then),
        },
        startRefusal: ports.startRefusal,
        cwdFor: ports.cwdFor,
    };
    const startOnDemand = (record: Parameters<HostApiDeps['cwdFor']>[0]) => startForWork({
        probe: (id) => ports.engine()?.probe(id) ?? null,
        start: (r, cwd) => engine().start(r, cwd),
        cwdFor: ports.cwdFor,
        startRefusal: ports.startRefusal,
    }, record);
    const deps: HostApiDeps = {
        ...(ports.schedule ? { schedule: ports.schedule } : {}),
        snapshot: () => registry.snapshot(),
        subscribeSnapshot: (listener) => registry.subscribe(listener),
        subscribeAgentRecords: (listener) => registry.subscribeAgentRecords(listener),
        find: (id) => registry.find(id as AgentId),
        detailFor: (id) => agentDetailFor({ registry, engine: ports.engine(), cwdFor: ports.cwdFor, mail: (agentId, limit) => ports.inbox.involving(agentId, limit) }, id as AgentId),
        cwdFor: ports.cwdFor,
        startForWork: startOnDemand,
        startForYourMessage: (record) => startForYourMessage({
            startForWork: startOnDemand,
            needsNewDriver: (id) => ports.engine()?.needsNewDriver(id) ?? false,
            restart: (id) => restartAgent(restartPorts, id, 'graceful'),
            notice: (id, message) => ports.engine()?.notice(id, message) ?? false,
        }, record),
        host: {
            start: (record, cwd) => engine().start(record, cwd),
            stop: (id) => engine().stop(id),
            cancel: (id, intent) => engine().cancel(id, 'you', intent),
            resumeLimit: (provider) => engine().resumeLimit(provider),
            prompt: (id, text, by) => engine().prompt(id, text, by),
            promptWith: (id, text, attachments, by) => engine().promptWith(id, text, attachments, by),
            resolvePrompt: (id, promptId, action) => engine().resolvePrompt(id, promptId, action),
            answerApproval: (id, optionId, note) => engine().answerApproval(id, optionId, note ?? ''),
            subscribe: (listener) => ports.engine()?.subscribe(listener) ?? (() => {}),
        },
        registerAgent: async () => { throw new Error(needsWindow('a new agent')); },
        attention: { finished: () => ports.attention.finished(), markSeen: (id) => ports.attention.markSeen(id) },
        terminals: windowOnly<HostApiDeps['terminals']>('terminals', { onData: () => () => {}, onExit: () => () => {} }),
        uploads: windowOnly<HostApiDeps['uploads']>('inbox.sendFile'),
        files: ports.files,
        serviceEnvFor: () => ({}),
        // Its settings-changed subscription is wired with the events: a no-op here, nothing else of it answers.
        workspaceOps: windowOnly<HostApiDeps['workspaceOps']>('workspaces', { onSettingsChanged: () => () => {} }),
        agentOps: windowOnly<HostApiDeps['agentOps']>('agents', { restart: (id, kind) => restartAgent(restartPorts, id, kind) }),
        features: windowOnly<HostApiDeps['features']>('features', {
            // The Deck's answer only (the phone's Deck, deck-answer.ts); the phone reads nothing back from it.
            act: async (action: FeatureAction) => {
                if (action.kind !== 'deck.answer' && action.kind !== 'deck.answerForm') throw new Error(needsWindow(`features.act ${action.kind}`));
                await answerDeck(action, { attention: ports.attention, approvals: ports.approvals, inbox: ports.inbox, deliverToAgent: ports.deliverToAgent });
                return {} as FeatureData;
            },
            onChange: () => () => {},
        }),
        updates: ports.updates ?? null,
    };
    return buildHostApi(deps);
}
