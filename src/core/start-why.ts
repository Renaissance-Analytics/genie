/**
 * WHY A RUN OF AN AGENT STARTED (Tynn #1085). Every start of an agent's session names its reason, and genie-host writes it
 * to lifecycle.log as ONE line per run (`agentRunLine`). Tracing the owner's stale questions, the log showed a restart of
 * every agent at once (2026-11-26T20:41:54) and single restarts with nothing to say what started them.
 *
 * - `start` — a plain start: the person's Start, a start for work (mail, a message), anything that did not say more;
 * - `restart` / `fresh` — the person's Restart, on the same conversation or a new one;
 * - `settings` — a start-time setting (model, tools) applied to a running agent;
 * - `mcp-recovery` — a session that came up without Genie's or Tynn's server, started again to reconnect;
 * - `keepalive` — the plan keepalive's restart after a stalled turn;
 * - `account-move` / `account-move-back` — moved to the new active account, or back when that run did not come up;
 * - `signed-in` — its provider signed in again, so the agents it had signed out come back;
 * - `account-back` — a paused account is back (Try again);
 * - `trust` — its workspace's trust verdict changed while it ran;
 * - `boot-restore` — Genie started and restored what was running at quit (or before an upgrade);
 * - `provider-reload` / `overload-reload` — the provider ended its run (an unconfirmed interrupt, an overload), so Genie
 *   loads the same conversation again;
 * - `new-driver` — its provider changed, so a message to it starts a new driver;
 * - `tynn-recovery` — its Tynn connection was repaired.
 *
 * A start a sign-in held, let go later, keeps the reason it was asked with.
 */
export type StartWhy =
    | 'start' | 'restart' | 'fresh' | 'settings' | 'mcp-recovery' | 'keepalive' | 'account-move' | 'account-move-back'
    | 'signed-in' | 'account-back' | 'trust' | 'boot-restore' | 'provider-reload' | 'overload-reload' | 'new-driver'
    | 'tynn-recovery';

export const START_WHYS: readonly StartWhy[] = [
    'start', 'restart', 'fresh', 'settings', 'mcp-recovery', 'keepalive', 'account-move', 'account-move-back', 'signed-in',
    'account-back', 'trust', 'boot-restore', 'provider-reload', 'overload-reload', 'new-driver', 'tynn-recovery',
];

/** A reason read off the wire: one of ours, or `start`. */
export function startWhyOf(value: unknown): StartWhy {
    return typeof value === 'string' && (START_WHYS as readonly string[]).includes(value) ? (value as StartWhy) : 'start';
}

/** The lifecycle.log line for one run. */
export function agentRunLine(agentId: string, run: number, why: StartWhy): string {
    return `agent run owner=${agentId} run=${run} why=${why}`;
}
