import type { HibernateResult, WakeResult } from './genie';

/**
 * What the window does with a HIBERNATING workspace (genie#672).
 *
 * A hibernating workspace has every terminal, process, site and service stopped,
 * and stays that way through restarts and upgrades until a person wakes it. The
 * rail greys it and puts three z's before its agents; the floor shows it asleep
 * with a way to wake it; no panel of it mounts. PURE, so the rules those surfaces
 * share are tested without a DOM.
 */

export function isHibernated(ws: { hibernated_at?: number | null } | undefined): boolean {
    return ws?.hibernated_at != null;
}

/**
 * Every spec whose panel may mount. A panel asks main for its pty as it mounts,
 * and in a sleeping workspace that is refused — so its panels are left out, and
 * the floor says the workspace is asleep instead of showing a wall of errors. A
 * spec whose workspace this window has not loaded is kept: not knowing is not
 * the same as asleep.
 */
export function awakeSpecs<T extends { workspace_id?: string | null }>(
    specs: readonly T[],
    workspacesById: ReadonlyMap<string, { hibernated_at?: number | null }>,
): T[] {
    return specs.filter((s) => !s.workspace_id || !isHibernated(workspacesById.get(s.workspace_id)));
}

export interface HibernationMessage {
    tone: 'ok' | 'warn' | 'error';
    text: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function hibernateOutcome(name: string, result: HibernateResult): HibernationMessage {
    if (!result.ok) return { tone: 'error', text: result.error };
    const parts = [`${name} is hibernating.`];
    const saved = result.handoffs.filter((h) => h.saved).length;
    if (saved > 0) parts.push(`${saved} ${plural(saved, 'agent', 'agents')} saved a handoff.`);
    const missed = result.handoffs.filter((h) => !h.saved).map((h) => h.agent);
    if (missed.length > 0) parts.push(`${missed.join(', ')} did not save a handoff.`);
    if (result.errors.length > 0) parts.push(`Not everything stopped cleanly: ${result.errors.join('; ')}`);
    return { tone: missed.length > 0 || result.errors.length > 0 ? 'warn' : 'ok', text: parts.join(' ') };
}

export function wakeOutcome(name: string, result: WakeResult): HibernationMessage {
    if (!result.ok) return { tone: 'error', text: result.error };
    if (result.errors.length === 0) return { tone: 'ok', text: `${name} is awake.` };
    return { tone: 'warn', text: `${name} is awake, but not everything came back: ${result.errors.join('; ')}` };
}
