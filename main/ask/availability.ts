/**
 * ForceTheQuestion AVAILABILITY — the CLIENT-side setting that decides whether an
 * agent's question pops the always-on-top modal now ("Available") or only lands in
 * the top-bar question inbox to answer at leisure ("DND"). Agents are uniform: they
 * always queue a question with a priority + workspace namespace; how it surfaces is
 * the USER'S choice, resolved per-workspace → per-workstation → global.
 *
 * Pure + electron-free so it unit-tests in the node vitest env (no jsdom). The
 * enforcement (suppress the modal + chime, return the DND notice, drop the question
 * into the inbox) lives in force-question.ts; the storage/read wiring reads these
 * from settings. See `.ai/plans/pending-questions-ux.md`.
 */

export type FtqAvailability = 'available' | 'dnd';

/** The default when nothing is set at any scope (owner: "Forced/Available by default"). */
export const DEFAULT_FTQ_AVAILABILITY: FtqAvailability = 'available';

/** The default agent-facing reply when the user is in DND (owner-authored, and
 *  itself a user-configurable setting — `ftq_dnd_message`). */
export const DEFAULT_DND_MESSAGE =
    'the user has notifications set to DND, if this is a show-stopper then hold off until they answer';

/** Coerce an untrusted stored value to a valid availability, else undefined so the
 *  resolver falls through to the next (broader) scope. */
export function asFtqAvailability(v: unknown): FtqAvailability | undefined {
    return v === 'available' || v === 'dnd' ? v : undefined;
}

/**
 * Resolve the EFFECTIVE availability for a question, MOST-SPECIFIC wins:
 * workspace → workstation → global → the Available default. `null`/`undefined` at a
 * scope means "unset — inherit the broader scope", so a per-workspace `dnd` overrides
 * an Available workstation, and an unset workspace inherits the workstation's choice.
 */
export function resolveFtqAvailability(scopes: {
    workspace?: FtqAvailability | null;
    workstation?: FtqAvailability | null;
    global?: FtqAvailability | null;
}): FtqAvailability {
    return (
        scopes.workspace ??
        scopes.workstation ??
        scopes.global ??
        DEFAULT_FTQ_AVAILABILITY
    );
}

/** Resolve the DND notice text for the agent — the configured message, or the
 *  default when unset/blank. Trimmed; a non-string/blank falls back to the default. */
export function resolveDndMessage(configured?: unknown): string {
    return typeof configured === 'string' && configured.trim() !== ''
        ? configured.trim()
        : DEFAULT_DND_MESSAGE;
}
