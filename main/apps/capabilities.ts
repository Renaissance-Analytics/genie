/**
 * PURE. What a GApp may ask Genie for, and what it may never have (Tynn #250).
 *
 * The owner's model is a mobile app store: an app declares the permissions it
 * wants, the user consents at install, and nothing outside that grant is
 * reachable. So a GApp declares CAPABILITIES, not raw tool names — "run commands
 * on this machine" is something a consent prompt can be written about; a list of
 * seventeen tool identifiers is not.
 *
 * ## The property that keeps this honest
 *
 * Every tool Genie advertises is classified here — either into a capability or
 * into {@link UNGRANTABLE_TOOLS} with a stated reason. A test asserts it against
 * `GENIE_TOOL_NAMES`, so adding a tool to Genie without deciding whether an app
 * may use it is a BUILD FAILURE, not a silent grant. Without that, the GApp attack
 * surface would quietly grow every time someone added a feature elsewhere.
 *
 * Nothing here grants anything. This is the vocabulary; `grant.ts` records what
 * the user actually consented to and `decideAppCall` enforces it.
 */

/** How much of the machine a capability hands over. */
export type CapabilityRisk = 'standard' | 'high';

export interface AppCapability {
    key: string;
    /** Short name, as the user sees it. */
    label: string;
    /** WHY the app wants it and what it means — a decision, not a category. */
    grantDescription: string;
    /** The Genie tools this capability governs. */
    tools: readonly string[];
    risk: CapabilityRisk;
    /**
     * True when using it puts words in front of the user. Genie stamps the app's
     * name on anything sent through it, so a GApp cannot dress its own prompt as a
     * Genie system prompt (the naming half of anti-impersonation lives in
     * `manifest.ts`; this is the runtime half).
     */
    mustAttribute?: true;
}

export const APP_CAPABILITIES: readonly AppCapability[] = [
    {
        key: 'terminals',
        label: 'Run commands',
        grantDescription:
            'Open terminals and run any command on this machine, as you. This is the widest thing an app can be given.',
        tools: ['manageTerminals'],
        risk: 'high',
    },
    {
        key: 'agents',
        label: 'Launch coding agents',
        grantDescription:
            'Start and steer autonomous coding agents, which can then change files and run commands on their own.',
        tools: ['runAgent'],
        risk: 'high',
    },
    {
        key: 'processes',
        label: 'Background and scheduled jobs',
        grantDescription:
            'Run supervised background processes and cron jobs, which keep running after the app window is closed.',
        tools: ['manageProcess'],
        risk: 'high',
    },
    {
        key: 'secrets',
        label: 'Environment variables and secrets',
        grantDescription:
            'Read and write workspace environment variables, which commonly hold API keys, tokens and database credentials.',
        tools: ['setEnv', 'checkEnv'],
        risk: 'high',
    },
    {
        key: 'hosting',
        label: 'Host sites and services',
        grantDescription:
            'Serve sites at .gen addresses and run backing services such as databases and caches.',
        tools: ['manageSite', 'manageService'],
        risk: 'standard',
    },
    {
        key: 'workspaces',
        label: 'See and manage workspaces',
        grantDescription:
            'List, open and create workspaces on this machine, within the scope you grant below.',
        tools: ['manageWorkspaces', 'provisionWorkspaces'],
        risk: 'standard',
    },
    {
        key: 'knowledge',
        label: "Genie's memory",
        grantDescription:
            'Read and write Genie’s knowledge graph — what it remembers about you, your projects and how work gets done here.',
        tools: ['knowledge'],
        risk: 'standard',
    },
    {
        key: 'issues',
        label: 'Issues and security alerts',
        grantDescription:
            'See the open GitHub issues, pull requests and security alerts Genie tracks for a workspace.',
        tools: ['checkIssues'],
        risk: 'standard',
    },
    {
        key: 'files',
        label: 'Open files for you',
        grantDescription:
            'Surface a file in Genie’s editor so you can look at it. Display only — it cannot read the file itself this way.',
        tools: ['openFileForUser'],
        risk: 'standard',
    },
    {
        key: 'notify',
        label: 'Get your attention',
        grantDescription:
            'Signal that it has finished and send you messages through the Agent Inbox, marked with the app’s name.',
        tools: ['imDone', 'agentinbox'],
        risk: 'standard',
        mustAttribute: true,
    },
    {
        key: 'ask',
        label: 'Interrupt you with a question',
        grantDescription:
            'Raise an always-on-top question over every other app and wait for your answer. Genie labels it with the app’s name.',
        tools: ['ForceTheQuestion'],
        risk: 'high',
        mustAttribute: true,
    },
];

/**
 * Tools no GApp may reach at any scope, and why.
 *
 * These are not "high risk" — they are OUT of the model. Each speaks on someone
 * else's behalf or exists to orient an agent, and neither is something a third
 * party gets to borrow.
 */
export const UNGRANTABLE_TOOLS: Readonly<Record<string, string>> = {
    submitFeedback:
        'Posts to the user’s Tynn project in their name. An app speaking to Tynn as the user is impersonation, whatever it says.',
    genieGuide:
        'Orientation for an agent working IN Genie, not a surface for an installed app; it also describes tools the app was never granted.',
    initializeWorkspace:
        'Hands back a map of the workspace and its repos — reconnaissance an app should not get for free from a tool meant to onboard agents.',
};

const TOOL_TO_CAPABILITY: ReadonlyMap<string, string> = new Map(
    APP_CAPABILITIES.flatMap((cap) => cap.tools.map((tool) => [tool, cap.key] as const)),
);

const CAPABILITY_KEYS: ReadonlySet<string> = new Set(APP_CAPABILITIES.map((c) => c.key));

/** The capability governing a tool, or null when nothing does — deny, never guess. */
export function capabilityForTool(tool: string): string | null {
    return TOOL_TO_CAPABILITY.get(tool) ?? null;
}

export function isAppCapability(key: string): boolean {
    return CAPABILITY_KEYS.has(key);
}

export function findCapability(key: string): AppCapability | undefined {
    return APP_CAPABILITIES.find((c) => c.key === key);
}
