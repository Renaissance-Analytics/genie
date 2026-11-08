import type { ElementDefinition } from './catalog.js';

/**
 * GENIE'S FLOW STEPS AS CATALOG ELEMENTS (ADF A5, Tynn #449) — pure, renderer-safe. The steps the flow palette offers and
 * the runner executes are `flow-node` elements of one builtin package, `ai.genie.flows`, registered through the catalog's
 * validator like everything else (main/genie-catalog.ts). What a flow may hold is read FROM the catalog
 * (core/catalog-projections.ts `catalogFlowKinds`, `catalogFlowTools`); this is the package's compiled declaration.
 *
 * Each step is offered because Genie's runner executes it: every kind has an executor test (test/flow-canvas-kinds.test.ts).
 * NOT offered, each because Genie cannot run it (Genie 1 refused the same set, main/flows/refusals.ts at v0.7.0-beta.342):
 * webhook_trigger (nowhere for a request to land), human_approval / user_input / rich_user_input (they park a run Genie
 * cannot resume), api_request / webhook_out (any URL), llm_call / llm_router / tool_use / embed_search (Genie does not call
 * models from a flow — prompt an agent instead), notify (somebody else's channels), memory_store / data_store (no store
 * decided), subflow / for_each (nested runs), fancy's terminal_* (no terminal host for flows — Run a command runs in the
 * workspace), lane (layout only).
 *
 * Genie's TOOLS as steps (genie#1204), `@genie/<tool>`: the tools of Genie 1's catalogue that Genie 2 has (Genie 1 name →
 * Genie 2 tool): manageTerminals, manageProcess → processes, manageSite → sites, manageService → services, knowledge,
 * checkIssues, openFileForUser, imDone, agentinbox, ForceTheQuestion. Not offered: Genie 1's runAgent, setEnv/checkEnv,
 * manageWorkspaces/provisionWorkspaces (Genie 2 has no such tool); Genie 2's thumbsUp and plan (an agent's own session),
 * createAgent, workspaceTabs and pages (the workspace's default agent only), flows and lists (an agent's own records) — a
 * flow cannot act as any of those callers.
 */

export const FLOW_PACKAGE_ID = 'ai.genie.flows';
const VERSION = '2.0.0';

/** [executor kind, what the palette calls it]. */
const STEPS: ReadonlyArray<readonly [string, string]> = [
    ['@particle-academy/manual_trigger', 'Run by hand'],
    ['@particle-academy/schedule_trigger', 'On a schedule'],
    ['genie/file_added', 'When a file is added'],
    ['genie/agent_prompt', 'Prompt an agent'],
    ['genie/terminal_run', 'Run a command'],
    ['genie/knowledge_add', 'Add to knowledge'],
    ['genie/file_move', 'Move a file'],
    ['@particle-academy/branch', 'Branch'],
    ['@particle-academy/switch_case', 'Switch'],
    ['@particle-academy/merge', 'Merge'],
    ['@particle-academy/transform', 'Transform'],
    ['@particle-academy/variable', 'Variable'],
    ['@particle-academy/wait', 'Wait'],
    ['@particle-academy/log', 'Log'],
    ['@particle-academy/output', 'Output'],
    ['@particle-academy/note', 'Note'],
];
/** Genie's tools a flow may call, each the `@genie/<tool>` step. */
const TOOLS: readonly string[] = ['knowledge', 'manageTerminals', 'processes', 'sites', 'services', 'checkIssues', 'openFileForUser', 'imDone', 'agentinbox', 'ForceTheQuestion'];

const slug = (kind: string) => kind.replace(/^@/, '').replace(/[^A-Za-z0-9_-]+/g, '-');
const REACH: ElementDefinition['reach'] = { scopes: ['workspace'], side: 'host', requiresWindow: false, remote: 'local' };

function step(id: string, name: string, description: string, payload: Record<string, unknown>): ElementDefinition {
    return {
        id: `${FLOW_PACKAGE_ID}.${id}`, kind: 'flow-node', version: VERSION, packageId: FLOW_PACKAGE_ID, source: 'builtin', aliases: [],
        docs: { name, description }, reach: REACH, permissions: { capabilities: [], network: [] }, payload,
    };
}

/** The `ai.genie.flows` package, as `Catalog.register` takes it. */
export function builtinFlowPackage(): { id: string; version: string; source: 'builtin'; contributions: ElementDefinition[] } {
    return {
        id: FLOW_PACKAGE_ID,
        version: VERSION,
        source: 'builtin',
        contributions: [
            ...STEPS.map(([kind, name]) => step(slug(kind), name, `The ${name} step (${kind}).`, { executor: kind })),
            ...TOOLS.map((tool) => step(`tool-${tool}`, `Genie: ${tool}`, `Genie's ${tool} tool as a step, run as the flow.`, { executor: `@genie/${tool}`, tool })),
        ],
    };
}
