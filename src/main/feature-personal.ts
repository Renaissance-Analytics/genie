import { readFile, stat } from 'node:fs/promises';
import { isAlertSoundKey } from '../core/alerts.js';
import { MAX_SOUND_BYTES, soundFileMime } from '../core/custom-sound.js';
import { canonicalKind, problemFromText, saveProblems, type FlowProblem } from '../core/flow-canvas.js';
import { canonicalFlowDocument, flowNodes, formEditable } from '../core/flow-form.js';
import { flowFormDefaults, knowledgeFormDefaults, validateFlowForm, validateKnowledgeForm, type Problem } from '../core/forms.js';
import { HUMAN, UNNAMED_AGENT, type Resolution } from '../core/inbox.js';
import { inboxThreads, pairOf, searchThread, threadKeyOfMessage, threadWindow, uncollected } from '../core/inbox-threads.js';
import type { FeatureAction, FeatureData, FlowSaved } from '../renderer/features.js';
import type { FeatureState } from './feature-ipc.js';
import { hostPathRefusal, type FeatureOrigin } from './host-picks.js';
import { importFlowDocument } from './flow-kinds.js';
import { flowToolDefinitions } from './flow-tools.js';
import type { FlowsApi } from './flows-host.js';
import type { AttentionStore } from './attention-store.js';
import type { InboxStore } from './inbox-store.js';
import type { KnowledgeStore } from './knowledge-store.js';
import type { SettingsStore } from './settings-store.js';

/** Both the canonical knowledge store and its window replica implement these operations. */
type MaybeAsync<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<Awaited<R>> : never };

/** Shared person-facing business rules; no Electron, window composition or second service graph. */
export interface PersonalFeatureServices {
    readonly settings: Pick<SettingsStore, 'snapshot' | 'get' | 'set' | 'reset'>;
    readonly knowledge: MaybeAsync<Pick<KnowledgeStore, 'summaries' | 'search' | 'add'>>;
    readonly flows: FlowsApi;
    readonly flowScheduler: { runNow(id: string): Promise<unknown> };
    readonly inbox: Pick<InboxStore, 'all' | 'unread' | 'involving' | 'send' | 'receive' | 'attachmentForPerson' | 'deleteThread'>;
    readonly attention: Pick<AttentionStore, 'asked'>;
    agentAddresses(): ReadonlyArray<{ address: string; agentId: string; name: string }>;
    resolveAddress(address: string): Resolution;
    mailRefusal(address: string): string | null;
    workspaceIds(): readonly string[];
    pluginsRefresh(): Promise<void>;
}

export interface PersonalFeatureEffects {
    readonly remoteAccess?: { apply(): Promise<void> };
    readonly openFlowEditor?: (route: string) => void;
}

const INBOX_THREAD_MAX = 2_000;
const INBOX_SEARCH_MAX = 200;

export async function personalFeatureSnapshot(services: PersonalFeatureServices, state: FeatureState): Promise<Pick<FeatureData, 'knowledge' | 'flows' | 'inbox' | 'settings'>> {
    // No query shows the graph's newest summaries, rather than loading every stored body.
    const hits = state.knowledgeQuery
        ? (await services.knowledge.search({ query: state.knowledgeQuery, scopes: 'all' })).hits
        : (await services.knowledge.summaries({ scopes: 'all', limit: 200 })).hits;
    const roster = services.agentAddresses();
    const peers = roster.map((a) => ({ address: a.address, agentId: a.agentId, name: a.name, reachable: true }));
    const mail = services.inbox.all();
    const visibleMail = new Set(mail.map((m) => m.id));
    const nameOf = participantNamer(roster, mail);
    return {
        knowledge: { hits, query: state.knowledgeQuery, adding: state.knowledgeAdding ?? null, lastAdd: state.knowledgeLastAdd ?? null },
        // The canvas registers these measured tool kinds before it mounts.
        flows: { flows: services.flows.list(), adding: state.flowAdding ?? null, ...(state.flowSaved ? { saved: state.flowSaved } : {}), toolKinds: flowToolDefinitions() },
        inbox: {
            unread: services.inbox.unread(HUMAN), peers, recent: services.inbox.involving(HUMAN, 200),
            threads: inboxThreads(mail, nameOf), uncollected: uncollected(mail),
            thread: state.inboxThread?.messages.every((m) => visibleMail.has(m.id)) ? state.inboxThread : null,
            servedAttachment: state.servedAttachment && mail.some((m) => m.attachments.some((a) => a.id === state.servedAttachment!.id)) ? state.servedAttachment : null,
            search: state.inboxSearch?.hits.every((m) => visibleMail.has(m.id)) ? state.inboxSearch : null,
            question: state.servedQuestion ?? null,
        },
        settings: { values: services.settings.snapshot() },
    };
}

/**
 * YOUR OWN SOUND, READ BY KEY (Tynn #766 B2; Genie 1's `settings:sound-data-url`): the renderer is sandboxed and cannot
 * read disk, so main reads the file the alert's setting names into a data URL. It is asked by SETTING KEY, never by
 * path, and reads only a sound file within the cap — so it is not a way to read an arbitrary file. `null` (the alert
 * plays its own sound) for no file, a gone file, a non-sound, a key that is not an alert sound, or one too big.
 */
export async function customSoundData(settings: { get(key: string): unknown }, key: string): Promise<string | null> {
    if (!isAlertSoundKey(key)) return null;
    const path = settings.get(`${key}_custom`);
    if (typeof path !== 'string' || path.trim() === '') return null;
    const mime = soundFileMime(path);
    if (!mime) return null;
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_SOUND_BYTES) return null;
        return `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
    } catch {
        return null;
    }
}

const USER = { kind: 'user' } as const;

/**
 * A participant by name: the person is `you`, an agent its roster name, an APP the label its mail carries
 * (`site:flabs@fancy`, genie#1345), one no longer here its id.
 */
function participantNamer(roster: ReadonlyArray<{ agentId: string; name: string }>, mail: ReadonlyArray<{ from: string; app?: { label: string } }> = []): (participant: string) => string {
    const apps = new Map<string, string>();
    for (const m of mail) if (m.app) apps.set(m.from, m.app.label);
    return (participant) => (participant === HUMAN ? 'you' : apps.get(participant) ?? roster.find((a) => a.agentId === participant)?.name ?? UNNAMED_AGENT);
}

/** An agent a flow would prompt must be one address on the roster NOW — the same rule the run resolves it by. */
function agentProblems(services: PersonalFeatureServices, document: unknown): Problem[] {
    return flowNodes(document).flatMap((n) => {
        const agent = n.kind === 'genie/agent_prompt' && typeof n.config?.agent === 'string' ? n.config.agent.trim() : '';
        if (!agent) return [];
        const found = services.resolveAddress(agent);
        if (found.kind === 'none') return [{ field: 'agent', message: `Node ${n.id}: no agent answers to ${agent}.` }];
        if (found.kind === 'human') return [{ field: 'agent', message: `Node ${n.id}: ${agent} is you, not an agent.` }];
        if (found.kind === 'ambiguous') return [{ field: 'agent', message: `Node ${n.id}: ${agent} names more than one agent (${found.forms.join(', ')}); use the full form.` }];
        return [];
    });
}

/**
 * THE CANVAS'S SAVE (genie#1204 item 1), as the person. Refused — nothing stored — with every problem on its node: what
 * only a save can know (core/flow-canvas.ts `saveProblems`: a trigger and a step, the schedule, the workspaces and agents
 * as they are now) and the store's own door (the engine, Genie's kinds, a loop — the door agents pass too). Stored, it is
 * never armed by the save; an ARMED flow whose save changes what it does is DISARMED and the answer says so — Genie 1's
 * `flows:save` (main/flows/ipc.ts:196-230 and `changesConsent` :315-361 at v0.7.0-beta.342): the person armed the flow as
 * it was, and moving a node or renaming it changes nothing they agreed to.
 */
async function saveGraph(services: PersonalFeatureServices, action: { flowId?: string; workspaceId: string; name: string; document: unknown }): Promise<FlowSaved> {
    const name = action.name.trim();
    const existing = action.flowId !== undefined ? services.flows.get(action.flowId) : null;
    if (action.flowId !== undefined && !existing) return { ok: false, problems: [{ message: 'that flow is gone; nothing was saved' }] };
    const workspaceId = existing?.workspaceId ?? action.workspaceId;
    const workspaces = services.workspaceIds();
    const problems: FlowProblem[] = [];
    if (name === '') problems.push({ message: 'name the flow' });
    if (!workspaces.includes(workspaceId)) problems.push({ message: `there is no workspace "${workspaceId}" in Genie` });
    problems.push(...saveProblems(action.document, { workspaces, agentProblem: (address) => agentWords(services, address) }));
    const door = importFlowDocument(action.document);
    if (!door.ok) for (const p of door.problems.map(problemFromText)) if (!problems.some((q) => q.nodeId === p.nodeId && q.message === p.message)) problems.push(p);
    if (problems.length > 0) return { ok: false, problems };
    if (!existing) {
        const made = await services.flows.create({ workspaceId, name, document: action.document, by: USER });
        return { ok: true, flowId: made.id, disarmed: false };
    }
    const disarm = existing.armed && consentDigest(existing.document) !== consentDigest(action.document);
    await services.flows.update(existing.id, { name, document: action.document }, USER);
    if (disarm) await services.flows.disarm(existing.id, USER);
    return { ok: true, flowId: existing.id, disarmed: disarm };
}

/** An agent address the run could not reach, in words; null when it reaches one agent (the inbox's own rule). */
function agentWords(services: PersonalFeatureServices, address: string): string | null {
    const found = services.resolveAddress(address);
    if (found.kind === 'none') return `no agent answers to ${address}`;
    if (found.kind === 'human') return `${address} is you, not an agent`;
    if (found.kind === 'ambiguous') return `${address} names more than one agent (${found.forms.join(', ')}); use the full form`;
    return null;
}

/** What the person agreed to when arming: each node's kind and config, and the wiring — not where nodes sit, or the name. */
function consentDigest(document: unknown): string {
    const nodes = flowNodes(document).map((n) => ({ id: String(n.id), kind: canonicalKind(String(n.kind)), config: n.config ?? null })).sort((a, b) => a.id.localeCompare(b.id));
    const doc = canonicalFlowDocument(document) as { graph?: { edges?: unknown } } | null;
    const edges = (Array.isArray(doc?.graph?.edges) ? (doc!.graph!.edges as Array<Record<string, unknown>>) : [])
        .map((e) => `${String(e.source)}:${String(e.sourceHandle ?? 'out')}->${String(e.target)}:${String(e.targetHandle ?? 'in')}`)
        .sort();
    return JSON.stringify({ nodes, edges });
}

/** Apply only this group, preserving the existing validation, human actor and refusal shapes. */
export async function applyPersonalFeatureAction(services: PersonalFeatureServices, action: FeatureAction, state: FeatureState, next: FeatureState, ports: PersonalFeatureEffects, origin: FeatureOrigin): Promise<boolean> {
    switch (action.kind) {
        case 'knowledge.search':
            next.knowledgeQuery = action.query;
            break;
        case 'flows.arm': {
            const r = await services.flows.arm(action.flowId, USER);
            if (!r.ok) throw new Error(r.reason);
            break;
        }
        case 'flows.disarm':
            await services.flows.disarm(action.flowId, USER);
            break;
        case 'flows.remove':
            if (!(await services.flows.remove(action.flowId))) throw new Error(`no flow ${action.flowId}`);
            break;
        case 'flows.runNow': {
            // Started, not awaited: a prompted agent's turn can take minutes. The outcome lands in the flow's run history,
            // and the store's change pushes the snapshot that shows it.
            if (!services.flows.get(action.flowId)) throw new Error(`no flow ${action.flowId}`);
            void services.flowScheduler.runNow(action.flowId).catch((error: unknown) => console.error(`[flows] run now: ${error instanceof Error ? error.message : String(error)}`));
            break;
        }
        case 'flows.openEditor':
            if (!ports.openFlowEditor) throw new Error('this Genie has no flow editor window');
            ports.openFlowEditor(`genie://flow/${encodeURIComponent(action.flowId)}`);
            break;
        case 'flows.newFlow':
            if (!ports.openFlowEditor) throw new Error('this Genie has no flow editor window');
            ports.openFlowEditor(`genie://flow/new?workspace=${encodeURIComponent(action.workspaceId)}`);
            break;
        case 'flows.saveGraph':
            next.flowSaved = await saveGraph(services, action);
            break;
        case 'flows.add':
            next.flowAdding = { defaults: flowFormDefaults({ workspaceId: action.workspaceId }), problems: [] };
            break;
        case 'flows.cancelForm':
            next.flowAdding = null;
            break;
        case 'flows.edit': {
            const flow = services.flows.get(action.flowId);
            if (!flow) throw new Error('That flow is gone.');
            if (!formEditable(flow.document)) throw new Error(`"${flow.name}" has more than one step, so this form cannot show all of it; it is edited by an agent (flows update) until the canvas editor lands.`);
            next.flowAdding = { defaults: { workspaceId: flow.workspaceId, name: flow.name, document: flow.document, armed: flow.armed }, problems: [], flowId: flow.id };
            break;
        }
        case 'flows.save': {
            const problems = [...validateFlowForm(action.form), ...agentProblems(services, action.form.document)];
            if (problems.length > 0) {
                const open = state.flowAdding ?? { defaults: action.form, problems: [], flowId: action.flowId };
                next.flowAdding = { ...open, problems };
                break;
            }
            // The form's own fields only: the armed state is the person's separate choice (Arm / Disarm), never the form's.
            await services.flows.update(action.flowId, { name: action.form.name, document: action.form.document }, USER);
            next.flowAdding = null;
            break;
        }
        case 'flows.create': {
            const problems = [...validateFlowForm(action.form), ...agentProblems(services, action.form.document)];
            if (problems.length > 0) {
                const open = state.flowAdding ?? { defaults: action.form, problems: [] };
                next.flowAdding = { ...open, problems };
                break;
            }
            next.flowAdding = null;
            await services.flows.create({ workspaceId: action.form.workspaceId, name: action.form.name, document: action.form.document, by: USER, armed: action.form.armed });
            break;
        }
        case 'knowledge.openAdd':
            next.knowledgeAdding = { defaults: knowledgeFormDefaults(action.workspaceId ? { workspaceId: action.workspaceId } : {}), problems: [] };
            break;
        case 'knowledge.cancelForm':
            next.knowledgeAdding = null;
            break;
        case 'knowledge.create': {
            const problems = validateKnowledgeForm(action.form);
            if (problems.length > 0) {
                next.knowledgeAdding = { defaults: action.form, problems };
                break;
            }
            const added = await services.knowledge.add({ title: action.form.title.trim(), body: action.form.body, class: action.form.class, scope: action.form.scope, source: 'user' });
            next.knowledgeAdding = null;
            // Show what was done: the search lands on the new title, and every link that did not
            // resolve is named with why — an ambiguous link resolves to nothing rather than guessing.
            next.knowledgeLastAdd = { id: added.id, title: action.form.title.trim(), unresolved: added.unresolved.map((u) => ({ ref: u.ref, reason: u.reason })) };
            next.knowledgeQuery = action.form.title.trim();
            break;
        }
        case 'knowledge.add': {
            const r = await services.knowledge.add({ title: action.title, body: action.body, ...(action.class ? { class: action.class } : {}), ...(action.tags ? { tags: action.tags } : {}), scope: action.scope, source: 'user' });
            void r;
            break;
        }
        case 'inbox.send': {
            const hibernated = services.mailRefusal(action.to);
            if (hibernated) throw new Error(hibernated);
            const target = services.resolveAddress(action.to);
            if (target.kind === 'none') throw new Error(`nobody at ${action.to}`);
            if (target.kind === 'ambiguous') throw new Error(`${action.to} names more than one agent — use one of: ${target.forms.join(', ')}`);
            if (target.kind === 'human') throw new Error('that is you');
            // A HOST PATH only from the host's own window, and only what its picker picked (genie#1354): a remote client
            // attaches bytes it uploads (`inbox.sendFile`). `origin` is main's, never the request's — see host-picks.ts.
            const refusal = hostPathRefusal(origin, action.attachments ?? []);
            if (refusal !== null) throw new Error(refusal);
            // One unreadable or executable path fails the whole send; the store says which (§6.4).
            await services.inbox.send({ from: HUMAN, to: target.id, text: action.text, ...(action.attachments && action.attachments.length > 0 ? { attachments: action.attachments } : {}) });
            break;
        }
        // THE AGENTINBOX FLYOUT (beta.33 item 19). A thread's history, by its key or by a message in it (a chat's mail row).
        case 'inbox.thread': {
            const mail = services.inbox.all();
            const key = action.key ?? (action.messageId ? threadKeyOfMessage(mail, action.messageId) : null);
            if (!key) throw new Error(action.messageId ? `no message ${action.messageId}` : 'which thread?');
            const limit = Math.min(Math.max(action.limit, 1), INBOX_THREAD_MAX);
            // A window by seq (the owner, 2026-11-01: sort and page): older BEFORE a seq, a live refresh FROM one.
            const t = threadWindow(mail, key, { limit, beforeSeq: action.beforeSeq, fromSeq: action.fromSeq });
            next.inboxThread = { key, messages: t.messages, more: t.more, newer: t.newer, limit, focus: action.messageId ?? null };
            break;
        }
        // Search ONE thread over its stored mail (the owner, 2026-11-01): history the flyout has not loaded is found too.
        case 'inbox.search': {
            if (!pairOf(action.key)) throw new Error(`${action.key} is not a thread`);
            const mail = services.inbox.all();
            const r = searchThread(mail, action.key, action.query, participantNamer(services.agentAddresses(), mail), INBOX_SEARCH_MAX);
            next.inboxSearch = { key: action.key, query: action.query, hits: r.hits, total: r.total };
            break;
        }
        // The questions an FTQ answer answered (the owner, 2026-11-01), read from the attention store's records.
        case 'inbox.question':
            next.servedQuestion = { id: action.questionId, record: services.attention.asked(action.questionId) };
            break;
        case 'inbox.markAllRead': {
            // The person's own receive, to the end: the only thing that marks mail read.
            const n = services.inbox.unread(HUMAN).length;
            if (n > 0) await services.inbox.receive({ participant: HUMAN, limit: n });
            break;
        }
        case 'inbox.attachment': {
            const a = await services.inbox.attachmentForPerson(action.attachmentId);
            next.servedAttachment = { id: action.attachmentId, name: a.name, base64: a.bytes.toString('base64') };
            break;
        }
        case 'inbox.deleteThread': {
            const pair = pairOf(action.key);
            if (!pair) throw new Error(`${action.key} is not a thread`);
            await services.inbox.deleteThread(pair[0] as never, pair[1] as never);
            break;
        }
        case 'inbox.markRead': {
            const unread = services.inbox.unread(HUMAN);
            const target = unread.find((m) => m.id === action.messageId);
            if (!target) throw new Error(`no unread message ${action.messageId}`);
            // Commit the human's cursor through the human's own receive, up to and including this
            // message — the only thing that marks mail read.
            const before = unread.filter((m) => m.seq < target.seq).length;
            await services.inbox.receive({ participant: HUMAN, limit: before + 1 });
            break;
        }
        case 'settings.set':
            await services.settings.set(action.key, action.value);
            // Publisher checks decide whether unsigned plugins are admitted (ADF B5): re-read the folder under the new rule.
            if (action.key === 'publisher_checks_off') await services.pluginsRefresh();
            // The host's switch (Tynn #820): the listener starts or stops with it, now.
            if (action.key === 'remote_access') await ports.remoteAccess?.apply();
            break;
        case 'settings.setSoundFile': {
            // Your own file for an alert (Tynn #766 B2): picked in the window over the host's disk (Tynn #835).
            if (!isAlertSoundKey(action.key)) throw new Error(`${action.key} is not an alert sound`);
            const path = action.path;
            if (!soundFileMime(path)) throw new Error(`${path.split(/[\\/]/).pop()} is not a sound file Genie can play (wav, mp3, ogg, m4a, aac, flac or webm)`);
            await services.settings.set(`${action.key}_custom`, path);
            await services.settings.set(action.key, 'custom');
            break;
        }
        case 'settings.reset':
            await services.settings.reset(action.key);
            break;
        default: return false;
    }
    return true;
}
