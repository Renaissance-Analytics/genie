/**
 * What the agent-terminal cap FIELD means (Tynn #117).
 *
 * Two surfaces edit this limit — the workstation default in Settings › Workspaces
 * › Defaults, and a workspace's override in Workspace settings › Agent behavior —
 * and both present the same two controls: a mode ("Inherit / Limit to / No
 * limit") beside a number. This module is what those controls MEAN, kept in one
 * place so the two surfaces cannot drift into disagreeing about an empty box.
 *
 * It is pure (no React, no electron) for a second reason: the renderer test lane
 * is Node-only, so judgement that lives inside a component is judgement nobody can
 * test. The enforcement side of the cap already has that discipline in
 * `main/terminal/agent-cap.ts`; this is its editing half.
 *
 * Every fallback here leans the same way — an unusable value resolves toward a
 * REAL limit, never toward `unlimited`. A cap that switches itself off because
 * someone typed a letter, or because a machine never opened Settings, is not a
 * cap. Only an explicit "No limit" removes it.
 *
 * The authority rule this serves: an agent that can raise its own cap has no cap.
 * These helpers only shape what a PERSON typed; the write itself goes through the
 * window-only `workspaces:set-max-agent-terminals` IPC, and nothing under
 * `main/mcp/` can reach it.
 */
import { DEFAULT_AGENT_TERMINAL_CAP, UNLIMITED } from '../../main/terminal/agent-cap';

/**
 * Which of the three things the field is currently saying.
 *
 * `'inherit'` mirrors the FTQ-availability override's sentinel in the same modal:
 * a level with no opinion, distinct from a level that chose something. The
 * workstation surface has no level above it, so it offers only the other two.
 */
export type AgentCapMode = 'inherit' | 'limit' | 'unlimited';

/** What the field currently says, once. */
export type AgentCapFieldValue =
    /** No opinion at this level — the level above (or the built-in default) wins. */
    | { kind: 'inherit' }
    /** Explicitly uncapped. Only ever reached by choosing it. */
    | { kind: 'unlimited' }
    | { kind: 'limit'; limit: number }
    /**
     * Half-typed or nonsensical. NOT a value: the caller leaves the stored setting
     * alone so the box stays usable while someone edits it, and so a stray
     * keystroke never writes a cap of zero that would stop the workspace dead.
     */
    | { kind: 'unusable' };

/** Digits only — `parseInt` would read `'2.5'` as 2 and `'1e3'` as 1, and a cap
 *  the user did not type is worse than one they have to retype. */
const DIGITS = /^[0-9]+$/;

function parseLimit(text: string): number | null {
    const t = text.trim();
    if (!DIGITS.test(t)) return null;
    const n = Number.parseInt(t, 10);
    return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Read the two controls as one value.
 *
 * The MODE is authoritative: switching away from "Limit to" must not persist the
 * number still sitting in the hidden box. Within `'limit'`, an EMPTY box means
 * inherit — clearing the number is how a person says "use the default", never
 * "remove the limit".
 */
export function readAgentCapField(mode: AgentCapMode, limit: string): AgentCapFieldValue {
    if (mode === 'inherit') return { kind: 'inherit' };
    if (mode === 'unlimited') return { kind: 'unlimited' };

    if (limit.trim() === '') return { kind: 'inherit' };
    const n = parseLimit(limit);
    return n === null ? { kind: 'unusable' } : { kind: 'limit', limit: n };
}

/** The stored workspace override, as the two controls should show it. */
export function agentCapField(cap: number | typeof UNLIMITED | null | undefined): {
    mode: AgentCapMode;
    limit: string;
} {
    if (cap === UNLIMITED) return { mode: 'unlimited', limit: '' };
    if (typeof cap === 'number') {
        const n = parseLimit(String(cap));
        // A stored number that is not a usable limit reads as "no opinion" — the
        // same direction `getWorkspaceAgentCap` takes for a corrupt row.
        return n === null ? { mode: 'inherit', limit: '' } : { mode: 'limit', limit: String(n) };
    }
    return { mode: 'inherit', limit: '' };
}

/**
 * The cap a workspace actually gets when it sets no override — the workstation
 * setting, or the built-in default when that is unset or unusable.
 *
 * DISPLAY ONLY. Enforcement resolves the same question in
 * `effectiveAgentCap`; this exists so the workspace field can say what it is
 * about to inherit instead of the useless word "default".
 */
export function inheritedAgentCap(
    raw: string | null | undefined,
): number | typeof UNLIMITED {
    if (raw === UNLIMITED) return UNLIMITED;
    if (typeof raw !== 'string') return DEFAULT_AGENT_TERMINAL_CAP;
    return parseLimit(raw) ?? DEFAULT_AGENT_TERMINAL_CAP;
}

/**
 * The workstation default row's two controls, from the stored setting STRING.
 *
 * No `'inherit'` here: this IS the level a workspace inherits from, and below it
 * lies only the built-in default. An unset or unusable setting shows that default
 * (matching the Max views row beside it, which renders `?? '4'`) so the box always
 * displays the number actually being enforced — but a box the user CLEARED stays
 * cleared, or it would refill itself under their cursor.
 */
export function workstationAgentCapField(raw: string | null | undefined): {
    mode: 'limit' | 'unlimited';
    limit: string;
} {
    if (raw === UNLIMITED) return { mode: 'unlimited', limit: '' };
    if (raw === '') return { mode: 'limit', limit: '' };
    if (typeof raw !== 'string') {
        return { mode: 'limit', limit: String(DEFAULT_AGENT_TERMINAL_CAP) };
    }
    const n = parseLimit(raw);
    return { mode: 'limit', limit: String(n ?? DEFAULT_AGENT_TERMINAL_CAP) };
}

/**
 * The setting STRING to persist for the workstation default, or `null` to ignore
 * the keystroke (the clamp-and-ignore-garbage shape the Max views row uses).
 *
 * A LOW number snaps to 1 rather than being refused, unlike the workspace field.
 * There the mode select carries the meaning and a rejected number just isn't
 * stored; here the number IS the setting, and a controlled input that silently
 * discards what you typed reads as a broken field. `''` is a real answer — it
 * means "no workstation opinion", which enforcement resolves to the built-in
 * default, never to unlimited.
 */
export function writeWorkstationAgentCap(
    mode: 'limit' | 'unlimited',
    limit: string,
): string | null {
    if (mode === 'unlimited') return UNLIMITED;
    const t = limit.trim();
    if (t === '') return '';
    if (!DIGITS.test(t)) return null;
    const n = Number.parseInt(t, 10);
    if (!Number.isInteger(n)) return null;
    return String(Math.max(1, n));
}

/** The inherited cap as a phrase for the sub-label — a real number, or "no limit". */
export function describeInheritedAgentCap(raw: string | null | undefined): string {
    const inherited = inheritedAgentCap(raw);
    if (inherited === UNLIMITED) return 'no limit';
    return `${inherited} agent terminal${inherited === 1 ? '' : 's'}`;
}
