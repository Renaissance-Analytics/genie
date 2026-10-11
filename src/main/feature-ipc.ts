import { classifyNavigation } from '../core/browser-policy.js';
import { validateFlowForm, validateSiteForm } from '../core/forms.js';
import { HUMAN } from '../core/inbox.js';
import type { ToolStatus } from '../core/toolchain.js';
import type { ComposedServices } from './compose.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';

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

export interface FeatureState {
    toolStatuses: readonly ToolStatus[] | null;
    knowledgeQuery: string;
    browserUrl?: string | null;
    toolchainCheckedAt?: number | null;
}

export async function featureSnapshot(services: ComposedServices, state: FeatureState): Promise<FeatureData> {
    const hits = state.knowledgeQuery ? services.knowledge.search({ query: state.knowledgeQuery, scopes: 'all' }).hits : null;
    const peers = services.agentAddresses().map((a) => ({ address: a.address, name: a.name, reachable: true }));
    return {
        knowledge: { hits, query: state.knowledgeQuery },
        flows: { flows: services.flows.list() },
        hosting: { sites: services.sites.list(), processes: services.supervisor.list() },
        toolchain: state.toolStatuses === null ? null : { tools: state.toolStatuses, checkedAt: state.toolchainCheckedAt ?? null },
        inbox: { unread: services.inbox.unread(HUMAN), peers },
        settings: { values: services.settings.snapshot() },
        browser: { url: state.browserUrl ?? null, routes: services.routes() },
    };
}

const USER = { kind: 'user' } as const;

/** Apply one action as the person, then answer with the next snapshot. Refusals throw with the reason. */
export async function handleFeatureAction(services: ComposedServices, action: FeatureAction, state: FeatureState = { toolStatuses: null, knowledgeQuery: '' }): Promise<FeatureData> {
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
        case 'flows.add':
        case 'hosting.addSite':
            // These open a form in the renderer; nothing changes in main until the form is submitted.
            break;
        case 'hosting.createSite': {
            const problems = validateSiteForm(action.form, services.sites.list().map((s) => s.host));
            if (problems.length > 0) throw new Error(problems.map((p) => p.message).join(' '));
            const f = action.form;
            services.sites.create({
                name: f.name,
                workspaceId: action.workspaceId,
                repoPath: action.repoPath,
                serve: f.mode === 'proxy' ? { mode: 'proxy' } : f.mode === 'static' ? { mode: 'static', root: f.root ?? 'dist', spa: f.spa } : { mode: 'php', root: f.root ?? 'public' },
                ...(f.devServer ? { devServer: f.devServer } : {}),
                ...(f.hostPort !== null ? { hostPort: f.hostPort } : {}),
            });
            break;
        }
        case 'flows.create': {
            const problems = validateFlowForm(action.form);
            if (problems.length > 0) throw new Error(problems.map((p) => p.message).join(' '));
            await services.flows.create({ workspaceId: action.form.workspaceId, name: action.form.name, document: action.form.document, by: USER, armed: action.form.armed });
            break;
        }
        case 'hosting.stopSite':
            if (!services.sites.stop(action.siteId)) throw new Error(`no site ${action.siteId}`);
            break;
        case 'hosting.removeSite':
            if (!services.sites.remove(action.siteId)) throw new Error(`no site ${action.siteId}`);
            break;
        case 'hosting.restartProcess':
            if (!services.supervisor.restart(action.processId)) throw new Error(`no process ${action.processId}`);
            break;
        case 'hosting.stopProcess':
            if (!services.supervisor.stop(action.processId)) throw new Error(`no process ${action.processId}`);
            break;
        case 'toolchain.check':
        case 'toolchain.update':
            // The scan and the update run through the toolchain prober with the real runner; the host
            // wires them in main.ts and feeds `toolStatuses` back through the state.
            break;
        case 'inbox.send': {
            const target = services.resolveAddress(action.to);
            if (target.kind === 'none') throw new Error(`nobody at ${action.to}`);
            if (target.kind === 'ambiguous') throw new Error(`${action.to} names more than one agent — use one of: ${target.forms.join(', ')}`);
            if (target.kind === 'human') throw new Error('that is you');
            await services.inbox.send({ from: HUMAN, to: target.id, text: action.text });
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
            break;
        case 'settings.reset':
            await services.settings.reset(action.key);
            break;
        case 'browser.navigate': {
            const nav = classifyNavigation(action.url, services.routes());
            if (nav.kind === 'refused') throw new Error(nav.reason);
            next.browserUrl = nav.kind === 'web' ? nav.url : nav.kind === 'site' ? `https://${nav.host}/` : `https://${nav.host}/`;
            break;
        }
    }
    return featureSnapshot(services, next);
}

