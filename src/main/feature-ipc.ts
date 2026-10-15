import { classifyNavigation } from '../core/browser-policy.js';
import type { SyncResult } from '../core/integrations.js';
import { resolveDeckAnswer, resolveDeckForm } from '../core/deck-resolve.js';
import { isDismissable } from '../core/deck.js';
import { shouldCheckUpdates } from './toolchain-prober.js';
import type { RepairOutcome } from '../core/toolchain.js';
import { flowFormDefaults, knowledgeFormDefaults, serviceFormDefaults, validateFlowForm, validateKnowledgeForm } from '../core/forms.js';
import type { FlowAdding, KnowledgeAdded, KnowledgeAdding, ServiceAdding, SiteAdding } from '../renderer/features.js';
import { HUMAN } from '../core/inbox.js';
import type { ToolStatus } from '../core/toolchain.js';
import type { RepairReport } from '../core/toolchain-repair.js';
import { updateRisk, type ToolchainActivity } from '../core/toolchain-risk.js';
import type { InstallOutcome } from './toolchain-ops.js';
import type { ComposedServices } from './compose.js';
import { createService, createSite, removeService, removeSite, setActiveService, siteDefaults, startService, startSite, stopService, stopSite } from './hosting-actions.js';
import type { HostedProcess, ProcessBook } from './process-book.js';
import type { FeatureAction, FeatureData, InstallPreview, ToolchainSection } from '../renderer/features.js';

/**
 * THE FEATURE SURFACES' MAIN-SIDE HALF.
 *
 * The renderer sends a `FeatureAction`; the main process applies it to the composed services and
 * answers with the next `FeatureData`. Every action from a surface is the PERSON acting — so arming
 * a flow here is allowed (an agent's arm goes through the MCP tool and is refused there), inbox mail
 * is sent FROM the human, and the knowledge search covers everything (the human sees all scopes).
 *
 * The snapshot is MEASURED for every section the services can answer at once; knowledge hits stay
 * `null` until a search is asked for, and the toolchain stays `null` until a scan has run — both
 * are "not asked yet", drawn as skeletons, never as empties.
 */

/** What main wires in that the tests inject: the toolchain prober/updater with its clock, and the kept background processes. */
export interface FeaturePorts {
    /** The background processes the person keeps (§6.6): written down, restored on launch. */
    readonly processes?: ProcessBook;
    readonly toolchain?: {
        probe(): Promise<ToolStatus[]>;
        update(tool: string): Promise<RepairOutcome | { kind: 'refused'; reason: string }>;
        now(): number;
        /** What is running right now — the update guard's input. An update is refused while this is not wired. */
        activity?(): Promise<ToolchainActivity>;
        /** T1: install one missing tool. The consent is the person's; the installer checks it too. */
        install?(tool: string, consent: boolean): Promise<InstallOutcome>;
        /** How a missing tool would be installed here, shown before anything runs. */
        preview?(tool: string): Promise<InstallPreview>;
        /** T2: Check and repair. */
        repair?(): Promise<RepairReport>;
    };
}

export interface FeatureState {
    toolStatuses: readonly ToolStatus[] | null;
    knowledgeQuery: string;
    browserUrl?: string | null;
    toolchainCheckedAt?: number | null;
    /** The Toolchain surface's own state beyond the scan (renderer/features.ts `ToolchainSection`). */
    toolchainInstalls?: Readonly<Record<string, InstallPreview>> | null;
    toolchainBusy?: string | null;
    toolchainFindings?: RepairReport['findings'] | null;
    toolchainRepairedAt?: number | null;
    toolchainWarning?: ToolchainSection['warning'] | null;
    toolchainResult?: string | null;
    siteAdding?: SiteAdding | null;
    flowAdding?: FlowAdding | null;
    serviceAdding?: ServiceAdding | null;
    knowledgeAdding?: KnowledgeAdding | null;
    knowledgeLastAdd?: KnowledgeAdded | null;
    /** Transient: the URL of a link minted by THIS action, served once. Never persisted into the next state. */
    servedLink?: { id: string; url: string } | null;
    lastSync?: { workspaceId: string; results: readonly SyncResult[] } | null;
}

/** The Toolchain section: the scan, plus each further fact only when there is one (never an empty placeholder). */
export function toolchainSection(state: FeatureState): ToolchainSection | null {
    if (state.toolStatuses === null) return null;
    return {
        tools: state.toolStatuses,
        checkedAt: state.toolchainCheckedAt ?? null,
        ...(state.toolchainInstalls ? { installs: state.toolchainInstalls } : {}),
        ...(state.toolchainBusy ? { busy: state.toolchainBusy } : {}),
        ...(state.toolchainFindings ? { findings: state.toolchainFindings } : {}),
        ...(typeof state.toolchainRepairedAt === 'number' ? { repairedAt: state.toolchainRepairedAt } : {}),
        ...(state.toolchainWarning ? { warning: state.toolchainWarning } : {}),
        ...(state.toolchainResult ? { result: state.toolchainResult } : {}),
    };
}

/** What main keeps of a toolchain action's answer for the next snapshot (the inverse of `toolchainSection`). */
export function toolchainStateFrom(section: ToolchainSection | null): Partial<FeatureState> {
    return {
        toolStatuses: section?.tools ?? null,
        toolchainCheckedAt: section?.checkedAt ?? null,
        toolchainInstalls: section?.installs ?? null,
        toolchainFindings: section?.findings ?? null,
        toolchainRepairedAt: section?.repairedAt ?? null,
        toolchainWarning: section?.warning ?? null,
        toolchainResult: section?.result ?? null,
    };
}

type ToolchainPort = NonNullable<FeaturePorts['toolchain']>;

/** Re-probe every tool (the snapshot shows the MEASURED state, never a command's word) and how each missing one would install. */
async function rescanToolchain(next: FeatureState, tc: ToolchainPort): Promise<void> {
    const tools = await tc.probe();
    next.toolStatuses = tools;
    next.toolchainCheckedAt = tc.now();
    if (tc.preview) {
        const missing = tools.filter((t) => t.tone === 'not-installed');
        next.toolchainInstalls = Object.fromEntries(await Promise.all(missing.map(async (t) => [t.tool, await tc.preview!(t.tool)] as const)));
    }
}

function describeInstall(tool: string, outcome: Exclude<InstallOutcome, { kind: 'refused' }>): string {
    switch (outcome.kind) {
        case 'installed':
            return `${tool}${outcome.version ? ` ${outcome.version}` : ''} is installed.${outcome.note ? ` (${outcome.note})` : ''}`;
        case 'already-installed':
            return `${tool} was already installed${outcome.version ? ` (${outcome.version})` : ''}; nothing was run.`;
        case 'not-installed':
            return `${tool} was not installed: ${outcome.reason}.`;
    }
}

function describeUpdate(tool: string, outcome: RepairOutcome): string {
    switch (outcome.kind) {
        case 'repaired':
            return `${tool} updated${outcome.from ? ` from ${outcome.from}` : ''} to ${outcome.to}.${outcome.note ? ` (${outcome.note})` : ''}`;
        case 'unchanged':
        case 'unverified':
            return `${tool}: ${outcome.reason}.`;
    }
}

/** How much of a process's log rides each snapshot: the end of it. All of it is the agents' `processes logs`. */
export const ROW_LOG_LINES = 40;

function withLogTails(services: ComposedServices, rows: readonly HostedProcess[]): HostedProcess[] {
    return rows.map((row) => {
        const log = services.supervisor.readLog(row.id, ROW_LOG_LINES);
        return log && log.lines > 0 ? { ...row, log } : row;
    });
}

export async function featureSnapshot(services: ComposedServices, state: FeatureState, ports: FeaturePorts = {}): Promise<FeatureData> {
    // No query = what the graph holds, newest first (the owner: "the knowledge graph is empty or not rendering" — it held
    // 108 memories and drew skeletons until a search). A query searches.
    const hits = state.knowledgeQuery
        ? services.knowledge.search({ query: state.knowledgeQuery, scopes: 'all' }).hits
        : services.knowledge.list({ scopes: 'all', limit: 200 }).nodes.map((n) => ({ id: n.id, title: n.title, snippet: n.body.replace(/\s+/g, ' ').trim().slice(0, 160), score: 0, tags: n.tags, class: n.class }));
    const peers = services.agentAddresses().map((a) => ({ address: a.address, name: a.name, reachable: true }));
    return {
        knowledge: { hits, query: state.knowledgeQuery, adding: state.knowledgeAdding ?? null, lastAdd: state.knowledgeLastAdd ?? null },
        flows: { flows: services.flows.list(), adding: state.flowAdding ?? null },
        // The kept processes are listed even when not running (a stop is durable, never a disappearance), each with the last
        // lines of its output — the supervisor's tail, so a crashed process still shows why (P1).
        hosting: { sites: services.sites.list(), processes: withLogTails(services, ports.processes ? ports.processes.list() : services.supervisor.list()), adding: state.siteAdding ?? null, frontDoor: services.externalFrontDoor },
        // Status is READ from Docker for every instance on every snapshot — never remembered; with Docker down, each says so.
        services: { instances: await services.engineStatuses(), adding: state.serviceAdding ?? null },
        toolchain: toolchainSection(state),
        // `recent`: the human's conversation (both directions, oldest first) — an observed agent's chat is its slice.
        inbox: { unread: services.inbox.unread(HUMAN), peers, recent: services.inbox.involving(HUMAN, 200) },
        settings: { values: services.settings.snapshot() },
        browser: { url: state.browserUrl ?? null, routes: services.routes() },
        integrations: { ...services.integrations(), lastSync: state.lastSync ?? null },
        plugins: { dir: services.pluginsDir, developerMode: services.settings.snapshot().developer_mode === true, entries: services.plugins.list(), panels: services.plugins.panels() as never },
        remote: {
            host: services.remote.hostName,
            url: services.remote.url(),
            unavailable: services.remote.unavailable(),
            locked: services.remote.locked(),
            pin: services.remote.activePin(),
            devices: services.remote.devices(),
            shares: services.remote.shares(),
            connections: services.remote.connections(),
            servedLink: state.servedLink ?? null,
        },
    };
}

const USER = { kind: 'user' } as const;

/** Apply one action as the person, then answer with the next snapshot. Refusals throw with the reason. */
export async function handleFeatureAction(services: ComposedServices, action: FeatureAction, state: FeatureState = { toolStatuses: null, knowledgeQuery: '' }, ports: FeaturePorts = {}): Promise<FeatureData> {
    const next: FeatureState = { ...state };
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
        // (the old no-op cases for flows.add / hosting.addSite were removed: a switch takes the first match)
        case 'hosting.addSite':
            next.siteAdding = { workspaceId: action.workspaceId, repoPath: action.repoPath, defaults: await siteDefaults(action.repoPath), problems: [] };
            break;
        case 'hosting.cancelForm':
            next.siteAdding = null;
            break;
        case 'flows.add':
            next.flowAdding = { defaults: flowFormDefaults({ workspaceId: action.workspaceId }), problems: [] };
            break;
        case 'flows.cancelForm':
            next.flowAdding = null;
            break;
        case 'hosting.createSite': {
            // The same call an agent's `sites add` makes (hosting-actions.ts): one validation, one env, one envelope write.
            const r = await createSite(services, { workspaceId: action.workspaceId, repoPath: action.repoPath, form: action.form });
            if (r.kind === 'problems') {
                // A refused submit is DATA for the form: shown beside the fields, where it was caused.
                const open = state.siteAdding ?? { workspaceId: action.workspaceId, repoPath: action.repoPath, defaults: await siteDefaults(action.repoPath), problems: [] };
                next.siteAdding = { ...open, problems: r.problems };
                break;
            }
            next.siteAdding = null;
            break;
        }
        case 'flows.create': {
            const problems = validateFlowForm(action.form);
            if (problems.length > 0) {
                const open = state.flowAdding ?? { defaults: action.form, problems: [] };
                next.flowAdding = { ...open, problems };
                break;
            }
            next.flowAdding = null;
            await services.flows.create({ workspaceId: action.form.workspaceId, name: action.form.name, document: action.form.document, by: USER, armed: action.form.armed });
            break;
        }
        case 'hosting.trustCertificate': {
            const r = await services.trustCertificate();
            if (!r.ok) throw new Error(r.reason);
            break;
        }
        case 'hosting.syncHosts':
            await services.syncHosts();
            break;
        case 'hosting.startSite':
            // The person's Start: serves a listed site that is not running, and lifts a remembered Stop.
            await startSite(services, action.siteId);
            break;
        case 'hosting.stopSite':
            // The person's Stop, remembered on this machine: the next launch leaves it down.
            await stopSite(services, action.siteId);
            break;
        case 'hosting.removeSite':
            // Removed from the workspace's envelope too, so it does not come back on the next launch.
            await removeSite(services, action.siteId);
            break;
        // A process the person keeps goes through the book, so their start/stop is written down and
        // holds through a restart; a site's or the front door's process is the supervisor's alone.
        case 'hosting.restartProcess':
            if (ports.processes?.owns(action.processId)) await ports.processes.restart(action.processId);
            else if (!services.supervisor.restart(action.processId)) throw new Error(`no process ${action.processId}`);
            break;
        case 'hosting.stopProcess':
            if (ports.processes?.owns(action.processId)) await ports.processes.stop(action.processId);
            else if (!services.supervisor.stop(action.processId)) throw new Error(`no process ${action.processId}`);
            break;
        case 'hosting.createProcess': {
            const book = ports.processes;
            if (!book) throw new Error('no process book is wired into this Genie; a background process cannot be kept');
            await book.create({ workspaceId: action.workspaceId, workspacePath: action.workspacePath, name: action.name, command: action.command, folder: action.folder, restart: action.restart });
            break;
        }
        case 'hosting.startProcess':
            if (!ports.processes?.owns(action.processId)) throw new Error(`no background process ${action.processId} that you keep`);
            await ports.processes.start(action.processId);
            break;
        case 'hosting.removeProcess':
            // A site's process goes with its site; only one the person keeps is removed here.
            if (!ports.processes?.owns(action.processId)) throw new Error(`no background process ${action.processId} that you keep; a site's process is removed with its site`);
            await ports.processes.remove(action.processId);
            break;
        case 'services.add':
            next.serviceAdding = { workspaceId: action.workspaceId, defaults: serviceFormDefaults({ workspaceId: action.workspaceId }), problems: [], consent: null };
            break;
        case 'services.cancelForm':
            next.serviceAdding = null;
            break;
        case 'services.create': {
            const open: ServiceAdding = state.serviceAdding ?? { workspaceId: action.form.workspaceId, defaults: action.form, problems: [], consent: null };
            // The same call an agent's `services add` makes (hosting-actions.ts); for an agent, the person's approval is the consent.
            const r = await createService(services, action.form, action.consent);
            if (r.kind === 'problems') {
                next.serviceAdding = { ...open, problems: r.problems, consent: null };
                break;
            }
            if (r.kind === 'needs-consent') {
                // The pull is a download the person should know about: the form stays open, ASKING, with the image named.
                next.serviceAdding = { ...open, problems: [], consent: { image: r.image, note: r.note, form: action.form } };
                break;
            }
            next.serviceAdding = null;
            break;
        }
        case 'services.setActive':
            await setActiveService(services, action.workspaceId, action.engine, action.version);
            break;
        case 'services.start':
            await startService(services, action.serviceId);
            break;
        case 'services.stop':
            await stopService(services, action.serviceId);
            break;
        case 'services.remove':
            await removeService(services, action.serviceId, { deleteData: action.deleteData });
            break;
        case 'toolchain.check': {
            const tc = ports.toolchain;
            if (!tc) throw new Error('no toolchain runner is wired into this Genie; the scan cannot run');
            if (shouldCheckUpdates(state.toolchainCheckedAt ?? null, tc.now(), action.force === true)) {
                await rescanToolchain(next, tc);
            }
            break;
        }
        case 'toolchain.update': {
            const tc = ports.toolchain;
            if (!tc) throw new Error('no toolchain runner is wired into this Genie; the update cannot run');
            // THE UPDATE-RISK GUARD (core/toolchain-risk.ts), read here in main from what is running NOW — never from the
            // renderer, and never optional: a guard that can be left unwired is not one.
            if (!tc.activity) throw new Error('the update guard is not wired into this Genie, so nothing is updated');
            const known = (state.toolStatuses ?? []).find((t) => t.tool === action.tool);
            const risk = updateRisk(action.tool, await tc.activity(), { installed: known ? known.installed !== null : true });
            if (risk.risk === 'blocked') throw new Error(risk.reason);
            if (risk.risk === 'warn' && action.confirmed !== true) {
                next.toolchainWarning = { tool: action.tool, reason: risk.reason, affected: risk.affected };
                break;
            }
            next.toolchainWarning = null;
            const outcome = await tc.update(action.tool);
            if (outcome.kind === 'refused') throw new Error(outcome.reason);
            next.toolchainResult = describeUpdate(action.tool, outcome);
            // The snapshot shows the RE-PROBE, never the command's word; and the cache is dropped.
            await rescanToolchain(next, tc);
            break;
        }
        case 'toolchain.install': {
            // Consent first, before anything is asked of the machine: no consent, nothing runs.
            if (action.consent !== true) throw new Error(`Genie installs nothing without your go-ahead; ${action.tool} was not installed`);
            const tc = ports.toolchain;
            if (!tc?.install) throw new Error('no installer is wired into this Genie; nothing was installed');
            const outcome = await tc.install(action.tool, true);
            if (outcome.kind === 'refused') throw new Error(outcome.reason);
            next.toolchainResult = describeInstall(action.tool, outcome);
            // A prerequisite now present is no longer a finding.
            if (outcome.kind !== 'not-installed' && next.toolchainFindings) {
                next.toolchainFindings = next.toolchainFindings.filter((f) => !(f.result.kind === 'needs-install' && f.result.tool === action.tool));
            }
            await rescanToolchain(next, tc);
            break;
        }
        case 'toolchain.repair': {
            const tc = ports.toolchain;
            if (!tc?.repair) throw new Error('Check and repair is not wired into this Genie; nothing was checked');
            const report = await tc.repair();
            next.toolchainFindings = report.findings;
            next.toolchainRepairedAt = report.checkedAt;
            const repaired = report.findings.filter((f) => f.result.kind === 'repaired').length;
            next.toolchainResult =
                report.findings.length === 0
                    ? "Nothing to repair: each tool runs its newest copy, PHP has a CA bundle, and nothing PHP needs is missing."
                    : `${report.findings.length} problem${report.findings.length === 1 ? '' : 's'} found, ${repaired} repaired.`;
            await rescanToolchain(next, tc);
            break;
        }
        case 'deck.answer':
        case 'deck.answerForm': {
            const command = action.kind === 'deck.answer' ? resolveDeckAnswer(action.item, action.optionId) : resolveDeckForm(action.item, action.selections, Array.isArray(action.notes) ? action.notes : [], action.note);
            switch (command.kind) {
                case 'refused':
                    throw new Error(command.reason);
                case 'answer-question':
                    await services.attention.answer(command.questionId, { selections: command.selections, notes: command.notes, note: command.note });
                    break;
                case 'resolve-approval':
                    if (!services.approvals.resolve(command.approvalId, command.choice)) throw new Error(`no pending approval ${command.approvalId}`);
                    break;
                case 'list-done':
                    if (!(await services.attention.lists.done({ workspaceId: command.workspaceId, id: command.itemId }))) throw new Error(`no list item ${command.itemId}`);
                    break;
                case 'mark-read': {
                    const unread = services.inbox.unread(HUMAN);
                    const target = unread.find((m) => m.id === command.messageId);
                    if (!target) throw new Error(`no unread message ${command.messageId}`);
                    await services.inbox.receive({ participant: HUMAN, limit: unread.filter((m) => m.seq < target.seq).length + 1 });
                    break;
                }
                case 'mark-seen':
                    services.attention.markSeen(command.finishedId);
                    break;
                case 'trust-certificate': {
                    // The same Trust as Hosting's line: one elevation, and a failure comes back with its reason.
                    const r = await services.trustCertificate();
                    if (!r.ok) throw new Error(r.reason);
                    break;
                }
                case 'defer-trust-certificate':
                    services.deferTrustCertificate();
                    break;
                case 'answer-provider-approval':
                case 'restart-with-handoff':
                case 'navigate':
                    // Session-layer and renderer concerns: main.ts routes these to the session host and the window.
                    throw new Error(`${command.kind} is handled by the session host, not the feature IPC`);
            }
            break;
        }
        case 'deck.dismiss':
            // An agent's question, put aside WITHOUT an answer: it leaves the Deck and the question window, and the asker is
            // mailed that it was dismissed (attention-store.ts). An approval or a forwarded question is not dismissable.
            if (!isDismissable(action.item)) throw new Error('only an agent’s question can be dismissed; an approval is answered with its own options');
            await services.attention.dismiss(action.item.id);
            break;
        case 'deck.dismissOlder':
            // "Dismiss all older than 1 day" — the store's clock decides what is old, each asker mailed once.
            await services.attention.dismissOlderThan(action.olderThanMs);
            break;
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
            const added = services.knowledge.add({ title: action.form.title.trim(), body: action.form.body, class: action.form.class, scope: action.form.scope, source: 'user' });
            next.knowledgeAdding = null;
            // Show what was done: the search lands on the new title, and every link that did not
            // resolve is named with why — an ambiguous link resolves to nothing rather than guessing.
            next.knowledgeLastAdd = { id: added.id, title: action.form.title.trim(), unresolved: added.unresolved.map((u) => ({ ref: u.ref, reason: u.reason })) };
            next.knowledgeQuery = action.form.title.trim();
            break;
        }
        case 'knowledge.add': {
            const r = services.knowledge.add({ title: action.title, body: action.body, ...(action.class ? { class: action.class } : {}), ...(action.tags ? { tags: action.tags } : {}), scope: action.scope, source: 'user' });
            void r;
            break;
        }
        case 'inbox.send': {
            const target = services.resolveAddress(action.to);
            if (target.kind === 'none') throw new Error(`nobody at ${action.to}`);
            if (target.kind === 'ambiguous') throw new Error(`${action.to} names more than one agent — use one of: ${target.forms.join(', ')}`);
            if (target.kind === 'human') throw new Error('that is you');
            // One unreadable or executable path fails the whole send; the store says which (§6.4).
            await services.inbox.send({ from: HUMAN, to: target.id, text: action.text, ...(action.attachments && action.attachments.length > 0 ? { attachments: action.attachments } : {}) });
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
            // Developer mode decides whether unsigned local plugins are admitted: re-read the folder under the new rule.
            if (action.key === 'developer_mode') await services.pluginsRefresh();
            break;
        case 'settings.reset':
            await services.settings.reset(action.key);
            break;
        case 'remote.issuePin':
            services.remote.issuePin();
            break;
        case 'remote.revokeDevice':
            if (!services.remote.revokeDevice(action.deviceId)) throw new Error(`no device ${action.deviceId}`);
            break;
        case 'remote.lock':
            services.remote.lock();
            break;
        case 'remote.unlock':
            services.remote.unlock();
            break;
        case 'remote.mintShare': {
            // Served exactly once: the URL rides this answer and no snapshot after it.
            const m = services.remote.mintShare({ workspaceId: action.workspaceId, grantedTo: action.grantedTo, expiresInMs: action.expiresInMs });
            next.servedLink = { id: m.link.id, url: m.url };
            break;
        }
        case 'integrations.tynnToken':
            await services.settings.set('tynn_token', action.token.trim());
            break;
        case 'integrations.githubConfirm': {
            const values = services.settings.snapshot();
            if (action.step === 'install' && values.github_authorized !== true) throw new Error('authorize first: the GitHub App must be authorized for your account before it can be installed on repositories');
            await services.settings.set(action.step === 'authorize' ? 'github_authorized' : 'github_installed', true);
            break;
        }
        case 'plugins.setEnabled':
            await services.plugins.setEnabled(action.id, action.enabled);
            break;
        case 'workspace.syncAgentFiles':
            // Sync now in a workspace's Settings: THAT workspace's agent files, then its four harness configs — by you.
            await services.syncAgentDocs(action.workspacePath, 'you');
            next.lastSync = { workspaceId: action.workspaceId, results: await services.syncConfig(action.workspacePath, 'you') };
            break;
        case 'remote.revokeShare':
            if (!services.remote.revokeShare(action.shareId)) throw new Error(`no share link ${action.shareId}`);
            break;
        case 'browser.navigate': {
            const nav = classifyNavigation(action.url, services.routes());
            if (nav.kind === 'refused') throw new Error(nav.reason);
            next.browserUrl = nav.kind === 'web' ? nav.url : nav.kind === 'site' ? `https://${nav.host}/` : `https://${nav.host}/`;
            break;
        }
    }
    return featureSnapshot(services, next, ports);
}

