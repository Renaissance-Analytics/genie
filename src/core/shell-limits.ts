import { SETTINGS } from './settings.js';

/**
 * A SHELLS LIMITER, PER WORKSPACE (beta.33). The owner (2026-10-20): "we have too many running shells. we need to include
 * a shells limiter". His answers (FTQ q_98d1c350): count EVERYTHING, as SEPARATE limits — agents' shells (what an agent's
 * Shells tab lists), terminals, background processes; PER WORKSPACE, kept as workspace settings on the workstation; at the
 * limit Genie REFUSES the new one and says the limit and what is running.
 *
 * Two of the three, for now: terminals and background processes, which Genie starts and so can refuse. An agent's own
 * shells (its Bash tool) need measuring first — what Genie can see and gate of them, and what it can do when the agent
 * runs with permissions bypassed — so no setting is offered for them yet (a control that does nothing is not offered).
 */
export type LimitKind = 'terminals' | 'processes';

/** The settings that hold them (core/settings.ts), workspace-scoped: a workstation default, overridden per workspace. */
export const LIMIT_KEYS: Readonly<Record<LimitKind, string>> = {
    terminals: 'limit_terminals',
    processes: 'limit_processes',
};

/** The numbers offered — a choice, as the running-agents cap is; no "unlimited", which is how there came to be too many. */
export const LIMIT_OPTIONS = ['1', '2', '3', '4', '6', '8', '12', '16', '24'] as const;

const NOUN: Readonly<Record<LimitKind, [string, string]>> = {
    terminals: ['terminal', 'terminals'],
    processes: ['background process', 'background processes'],
};
const SETTING_LABEL: Readonly<Record<LimitKind, string>> = {
    terminals: 'Terminals per workspace',
    processes: 'Background processes per workspace',
};

function defaultOf(kind: LimitKind): number {
    const def = SETTINGS.find((s) => s.key === LIMIT_KEYS[kind]);
    return Number(def?.default ?? 8);
}

/** The limit, from a workspace's settings (`SettingsStore.snapshotFor`): a stored positive number, else the default. */
export function limitOf(values: Readonly<Record<string, unknown>>, kind: LimitKind): number {
    const n = Number(values[LIMIT_KEYS[kind]]);
    return Number.isInteger(n) && n > 0 ? n : defaultOf(kind);
}

/**
 * What a refusal says — the limit, what is running (by name), and where it is changed — or `null` while there is room.
 * The same words reach an agent (its tool's error) and the person (the notice where they asked).
 */
export function limitRefusal(kind: LimitKind, limit: number, running: readonly string[]): string | null {
    if (running.length < limit) return null;
    const [one, many] = NOUN[kind];
    return `This workspace allows ${limit} ${limit === 1 ? one : many} and ${running.length} ${running.length === 1 ? 'is' : 'are'} running: ${running.join(', ')}. Stop one, or raise “${SETTING_LABEL[kind]}” in the workspace's Settings.`;
}

/** A refusal's own words, for the person: an IPC rejection arrives wrapped in "Error invoking remote method '…': Error: ". */
export function refusalText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}
