import type { Settings } from '../genie';
import type { Recipe, RecipeContext, RecipeField, RecipeOption } from './types';

/**
 * The Workstation Setup recipe — the first real consumer of the WizardModal +
 * Recipe framework.
 * ===========================================================================
 *
 * A cloud workstation's git operations use the OWNER's own `gh` auth (not an App
 * token), so cross-owner private submodules resolve. This recipe walks a first-
 * connecting owner through: choosing a default agent + enabling others, setting
 * per-agent launch flags, and the GitHub `gh auth login` device flow +
 * `gh auth setup-git`. It renders in the HOST window (so `api()` is the remote
 * bridge): the embedded terminals spawn on the headless host (bound to the
 * reserved `__genie_setup__` workspace, visible before any real workspace
 * exists), while the device-login page opens in the owner's OWN local browser.
 *
 * The recipe is DATA + a little pure logic (see {@link buildAgentSettingsPatch}).
 * The RecipeEngine + the WizardModal step views own all rendering, the terminal
 * lifecycle, the browser hand-off and gating.
 */

export const WORKSTATION_SETUP_RECIPE_ID = 'workstation-setup';

/** Reserved synthetic workspace the setup terminals bind to on a workspace-less
 *  host (mirrors genie-cloud `SETUP_TERMINAL_WORKSPACE_ID`). The WizardModal is
 *  launched with this as its `workspaceId`, so every embedded terminal spawns on
 *  the host under the reserved binding. */
export const SETUP_WORKSPACE_ID = '__genie_setup__';

/** Host endpoints the recipe drives over the remote bridge (`api().remote.request`). */
export const SETUP_STATUS_PATH = '/api/desktop/setup/status';
export const SETUP_COMPLETE_PATH = '/api/desktop/setup/complete';

/**
 * The supported agents (id + label). MIRRORS genie-cloud's `AGENT_CATALOG`
 * (src/setup/agents.ts) and genie's `AgentType` (`claude | codex | custom`) — the
 * fixed set the launch pipeline reads via `agent_command_<id>` / `agent_flags_<id>`.
 * Kept in sync by hand (the desktop cannot import genie-cloud). The KNOWN launch
 * flags live in {@link AGENT_FLAG_CATALOG} (single source of truth) so a flag is
 * never duplicated here and there.
 */
export const SETUP_AGENTS = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'custom', label: 'Custom command' },
] as const;

/** The canonical agent ids, in catalog order. */
const AGENT_IDS = SETUP_AGENTS.map((a) => a.id);

type AgentId = (typeof AGENT_IDS)[number];

/** `agent_flags_<id>` context/settings key for an agent. */
const flagKey = (id: string): 'agent_flags_claude' | 'agent_flags_codex' | 'agent_flags_custom' =>
    `agent_flags_${id}` as 'agent_flags_claude' | 'agent_flags_codex' | 'agent_flags_custom';

const agentOptions: RecipeOption[] = SETUP_AGENTS.map((a) => ({ value: a.id, label: a.label }));

/** One known, documented launch flag an agent can be started with — a single
 *  checkbox in the "Agent options" step (Bug 2). */
export interface AgentFlagOption {
    /** The exact flag appended to the agent's launch command (verbatim). */
    flag: string;
    /** Short checkbox label. */
    label: string;
    /** One-line explanation shown under the checkbox. */
    description: string;
}

/**
 * The catalog of KNOWN, safe launch flags offered per agent — the checkbox set the
 * "Agent options" step renders (Bug 2). Ticked flags compose (order-preserving,
 * de-duped) into the `agent_flags_<id>` string the launch pipeline appends. Kept
 * intentionally small and documented: every entry is a real, current CLI flag.
 * An agent with an EMPTY catalog (custom) falls back to a free-text field so its
 * flags are still editable ({@link agentFlagFields}).
 */
export const AGENT_FLAG_CATALOG: Record<AgentId, AgentFlagOption[]> = {
    claude: [
        {
            flag: '--dangerously-skip-permissions',
            label: 'Skip permission prompts',
            description:
                'Run tools without approving each one. Recommended for an autonomous workstation.',
        },
    ],
    codex: [
        {
            flag: '--yolo',
            label: 'Full-auto (--yolo)',
            description: 'Skip approvals and the sandbox. Recommended for an autonomous workstation.',
        },
        {
            flag: '--full-auto',
            label: 'Full-auto in a sandbox (--full-auto)',
            description: 'Auto-run edits and commands inside a sandbox — safer than --yolo.',
        },
    ],
    custom: [],
};

/**
 * The enabled agent ids the owner ticked in the "Enable agents" step, narrowed to
 * KNOWN ids and returned in catalog order (de-duped). Reads the multi-choice value
 * (`enabled-agents`), tolerating a single non-array value. Drives the DYNAMIC
 * agent-flags fields so a disabled agent never shows a flags control.
 */
export function enabledAgentIds(ctx: Pick<RecipeContext, 'get'>): AgentId[] {
    const raw = ctx.get('enabled-agents');
    const chosen = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
    return AGENT_IDS.filter((id) => chosen.includes(id));
}

/**
 * Build the "Agent options" form fields for exactly the ENABLED agents (Bug 2):
 * a `checkboxes` field seeded from {@link AGENT_FLAG_CATALOG} for each agent that
 * has known flags, and a free-text field for one that doesn't (custom). Empty when
 * no agents are enabled — the form then never blocks (nothing required).
 */
export function agentFlagFields(enabledIds: string[]): RecipeField[] {
    const enabled = AGENT_IDS.filter((id) => enabledIds.includes(id));
    return enabled.map((id) => {
        const label = SETUP_AGENTS.find((a) => a.id === id)?.label ?? id;
        const catalog = AGENT_FLAG_CATALOG[id];
        if (catalog.length > 0) {
            return {
                key: flagKey(id),
                label: `${label} options`,
                type: 'checkboxes',
                description: 'Tick the launch flags to start this agent with.',
                options: catalog.map((f) => ({
                    value: f.flag,
                    label: f.label,
                    description: f.description,
                })),
            } satisfies RecipeField;
        }
        return {
            key: flagKey(id),
            label: `${label} — extra flags`,
            type: 'text',
            placeholder: '--flag ...',
            description: 'Optional flags appended to your custom agent command.',
        } satisfies RecipeField;
    });
}

/**
 * Compose a stored flag selection into the single `agent_flags_<id>` string the
 * launch pipeline appends. A `checkboxes` field stores a STRING[] of ticked flags
 * (joined, order-preserving, de-duped, blanks/non-strings dropped); a free-text
 * field stores a plain string (trimmed). Anything else → no flags.
 */
export function composeAgentFlags(value: unknown): string {
    if (Array.isArray(value)) {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const v of value) {
            if (typeof v !== 'string') continue;
            const f = v.trim();
            if (!f || seen.has(f)) continue;
            seen.add(f);
            out.push(f);
        }
        return out.join(' ');
    }
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turn the wizard's agent choices into the genie settings patch to persist on the
 * host. Writes the raw `agent_flags_<id>` strings the launch pipeline appends
 * verbatim, plus the `agent_default` / `agent_enabled` bookkeeping the host's
 * setup-status reads and a re-run pre-fills from. NEVER writes `agent_command_<id>`
 * — the wizard doesn't collect a command, and overwriting one would clobber a
 * user's custom wrapper/path.
 */
export function buildAgentSettingsPatch(input: {
    defaultAgent?: string;
    enabledAgents: string[];
    flags: Record<string, string | undefined>;
}): Partial<Settings> {
    const known = (id: string): boolean => AGENT_IDS.includes(id as (typeof AGENT_IDS)[number]);
    const defaultAgent =
        input.defaultAgent && known(input.defaultAgent)
            ? input.defaultAgent
            : input.enabledAgents.find(known) ?? 'claude';

    // Enabled = the chosen known agents in their chosen order (de-duped); the
    // default is prepended only when it isn't already in the set (matches
    // genie-cloud's machine.ts so both sides agree on the persisted set).
    const knownEnabled: string[] = [];
    for (const id of input.enabledAgents) {
        if (known(id) && !knownEnabled.includes(id)) knownEnabled.push(id);
    }
    const enabled = knownEnabled.includes(defaultAgent)
        ? knownEnabled
        : [defaultAgent, ...knownEnabled];

    const patch: Partial<Settings> = {
        agent_default: defaultAgent,
        agent_enabled: JSON.stringify(enabled),
    };
    for (const id of AGENT_IDS) {
        patch[flagKey(id)] = (input.flags[id] ?? '').trim();
    }
    return patch;
}

export const workstationSetupRecipe: Recipe = {
    id: WORKSTATION_SETUP_RECIPE_ID,
    title: 'Workstation setup',
    steps: [
        {
            type: 'choice',
            id: 'default-agent',
            title: 'Choose your default agent',
            options: agentOptions,
        },
        {
            type: 'choice',
            id: 'enabled-agents',
            title: 'Enable agents',
            multi: true,
            options: agentOptions,
        },
        {
            // A FORM (not a choice) so it never blocks: flags are optional, and a
            // choice step is only forward-satisfied with a selection. DYNAMIC on the
            // prior step (Bug 2): it shows a checkbox set of known flags for ONLY the
            // agents the owner enabled — never a free-text box for every agent.
            type: 'form',
            id: 'agent-flags',
            title: 'Agent options',
            fields: (ctx) => agentFlagFields(enabledAgentIds(ctx)),
        },
        {
            // Persist agent choices to the HOST (host-sourced settings) BEFORE the
            // GitHub steps, so a re-run pre-fills even if the owner stops at gh auth.
            type: 'task',
            id: 'persist-agents',
            title: 'Save agent settings',
            run: async (ctx) => {
                const enabledRaw = ctx.get('enabled-agents');
                const enabledAgents = Array.isArray(enabledRaw)
                    ? (enabledRaw as string[])
                    : enabledRaw
                      ? [String(enabledRaw)]
                      : [];
                const flags: Record<string, string> = {};
                for (const a of SETUP_AGENTS) flags[a.id] = composeAgentFlags(ctx.get(flagKey(a.id)));
                const patch = buildAgentSettingsPatch({
                    defaultAgent: ctx.get('default-agent') as string | undefined,
                    enabledAgents,
                    flags,
                });
                await ctx.api().settings.set(patch);
            },
        },
        {
            // gh's device flow, shown in a live host terminal, WITH the device page
            // opening on the owner's own machine at the same time (Bug 3). gh prints a
            // one-time code and polls; `openUrl` opens the entry page locally as the
            // step activates, so the owner reads the code HERE and enters it on the
            // just-opened page (authorizing the Civicognita + wishborn orgs — SSO).
            // Advances when gh exits 0. No separate, out-of-order browser step.
            type: 'terminal',
            id: 'gh-login',
            title: 'Sign in to GitHub',
            command: 'gh',
            args: ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
            openUrl: 'https://github.com/login/device',
        },
        {
            // Register gh as git's credential helper, then verify the session is live.
            // A single shell so the step advances only when BOTH succeed (exit 0).
            type: 'terminal',
            id: 'gh-setup-git',
            title: 'Configure git credentials',
            command: 'sh',
            args: ['-c', 'gh auth setup-git && gh auth status'],
        },
        {
            // Mark setup complete on the host: sets the flag, drains the queued
            // provisioning, and reports the gate to Tynn (the completion seam).
            type: 'task',
            id: 'complete',
            title: 'Finish setup',
            run: async (ctx) => {
                await ctx.api().remote.request(SETUP_COMPLETE_PATH, { method: 'POST' });
            },
        },
    ],
};
