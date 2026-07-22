import type { Settings } from '../genie';
import type { Recipe, RecipeOption } from './types';

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
 * The supported agents + their recommended launch flag. MIRRORS genie-cloud's
 * `AGENT_CATALOG` (src/setup/agents.ts) and genie's `AgentType`
 * (`claude | codex | custom`) — the fixed set the launch pipeline reads via
 * `agent_command_<id>` / `agent_flags_<id>`. Kept in sync by hand (the desktop
 * cannot import genie-cloud); the flag is surfaced as a placeholder/description
 * hint so it stays OPT-IN, not a silent default.
 */
export const SETUP_AGENTS = [
    {
        id: 'claude',
        label: 'Claude Code',
        recommendedFlag: '--dangerously-skip-permissions',
        flagHint: 'e.g. --dangerously-skip-permissions to run without approving each tool use.',
    },
    {
        id: 'codex',
        label: 'Codex',
        recommendedFlag: '--yolo',
        flagHint: 'e.g. --yolo for full-auto (skip approvals & sandbox).',
    },
    {
        id: 'custom',
        label: 'Custom command',
        recommendedFlag: '',
        flagHint: 'Optional flags for your custom agent command.',
    },
] as const;

/** The canonical agent ids, in catalog order. */
const AGENT_IDS = SETUP_AGENTS.map((a) => a.id);

/** `agent_flags_<id>` context/settings key for an agent. */
const flagKey = (id: string): 'agent_flags_claude' | 'agent_flags_codex' | 'agent_flags_custom' =>
    `agent_flags_${id}` as 'agent_flags_claude' | 'agent_flags_codex' | 'agent_flags_custom';

const agentOptions: RecipeOption[] = SETUP_AGENTS.map((a) => ({ value: a.id, label: a.label }));

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
            // choice step is only forward-satisfied with a selection. Each field is
            // the raw `agent_flags_<id>` string the launch pipeline appends verbatim.
            type: 'form',
            id: 'agent-flags',
            title: 'Agent options',
            fields: SETUP_AGENTS.map((a) => ({
                key: flagKey(a.id),
                label: `${a.label} — extra flags`,
                placeholder: a.recommendedFlag,
                description: `Optional. ${a.flagHint}`,
            })),
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
                for (const a of SETUP_AGENTS) flags[a.id] = String(ctx.get(flagKey(a.id)) ?? '');
                const patch = buildAgentSettingsPatch({
                    defaultAgent: ctx.get('default-agent') as string | undefined,
                    enabledAgents,
                    flags,
                });
                await ctx.api().settings.set(patch);
            },
        },
        {
            // Open the device-login page in the owner's LOCAL browser FIRST, so it is
            // ready when the terminal shows the one-time code. Headless-robust: the
            // BrowserStep also displays the URL as a copy-fallback.
            type: 'browser',
            id: 'gh-device',
            title: 'Open GitHub device login',
            url: 'https://github.com/login/device',
        },
        {
            // gh's device flow: prints a one-time code + polls. The owner reads the
            // code here and enters it on the device page opened above, authorizing
            // the Civicognita + wishborn orgs (SSO). Advances when gh exits 0.
            type: 'terminal',
            id: 'gh-login',
            title: 'Sign in to GitHub',
            command: 'gh',
            args: ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
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
