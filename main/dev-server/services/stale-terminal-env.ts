/**
 * WHAT AN OPEN TERMINAL'S SERVICE ENV NO LONGER MATCHES (genie#222, genie#540).
 *
 * TWO states, because a pty's environment drifts in two ways that mean
 * different things: a value it holds is now WRONG (#222, the file's original
 * subject, below), or a service it never received has appeared since
 * ({@link incompleteServiceTerminals}, at the bottom). The file kept its name
 * because staleness is still the half that is a problem.
 *
 * A managed engine's PUBLISHED host port moves when its container is recreated.
 * `#242` took the application's configuration out of a terminal's environment
 * and put it in the repo's `.env`, which Genie now keeps current — so a moved
 * port can no longer override a `.env` somebody had just corrected. What #242
 * deliberately leaves in the pty is the CLIENT-TOOL credentials (`PG*`,
 * `MYSQL_*`), so `psql` connects with nothing typed.
 *
 * Those are a snapshot taken at spawn, and a pty's environment cannot be
 * rewritten afterwards. The issue records the residual exactly:
 *
 *   > A terminal's service env is baked in at creation and there is no way to
 *   > re-inherit it. The only remedy today is opening a new terminal, and
 *   > NOTHING TELLS YOU that is what you need.
 *
 * The first half is a property of ptys. The second half is the defect: Genie
 * held both values and said nothing — `onPortMoved` wrote to `console.warn`,
 * which no user and no agent reads. So the comparison is surfaced where somebody
 * is already asking the question, in `manageService`.
 *
 * The store is a plain module-level Map rather than a database table on purpose:
 * a terminal's inherited environment lives exactly as long as the pty, and a row
 * that outlived a Genie restart would describe a process that no longer exists.
 * Every read is filtered by the caller's list of terminals that are actually
 * open, so a forgotten entry can never produce a claim about a dead terminal.
 */

import { groupEnvKeysByService } from './env-wiring';

/** The service env one terminal was spawned with, by terminal id. */
const snapshots = new Map<string, Record<string, string>>();

/** Record what a terminal inherited, at the moment it inherits it. Replaces any
 *  previous snapshot — a terminal is spawned once and this is that spawn. */
export function recordTerminalServiceEnv(terminalId: string, env: Record<string, string>): void {
    snapshots.set(terminalId, { ...env });
}

/** Drop a terminal's snapshot (it closed, or a test is starting clean). */
export function forgetTerminalServiceEnv(terminalId: string): void {
    snapshots.delete(terminalId);
}

/** One open terminal whose inherited service env no longer matches the live one. */
export interface StaleTerminalEnv {
    terminalId: string;
    /** The keys whose value has CHANGED or been withdrawn, sorted. */
    keys: string[];
}

/**
 * The open terminals carrying a value the workspace no longer publishes.
 *
 * `live` is the current service env for the workspace, in the same form the
 * terminal was given. `openTerminalIds` is the caller's list of terminals that
 * still exist — a closed terminal is dialling nothing, and naming one would send
 * someone looking for a pane that is not there.
 *
 * A key that APPEARED since the spawn is not staleness. A workspace that gained
 * its first Postgres leaves every earlier terminal without `PGPORT`, which is a
 * missing value rather than a wrong one; calling it stale would fire on every
 * first `add`. A key that went AWAY is stale — that terminal is still pointed at
 * an engine this workspace no longer has.
 */
export function staleServiceTerminals(
    live: Record<string, string>,
    openTerminalIds: readonly string[],
): StaleTerminalEnv[] {
    const out: StaleTerminalEnv[] = [];
    for (const terminalId of [...openTerminalIds].sort()) {
        const had = snapshots.get(terminalId);
        if (!had) continue;
        const keys = Object.keys(had)
            .filter((key) => live[key] !== had[key])
            .sort();
        if (keys.length > 0) out.push({ terminalId, keys });
    }
    return out;
}

/**
 * What to tell the caller, or null when there is nothing to say.
 *
 * Names the terminals, states the remedy, and is explicit that the APP is not
 * affected — `.env` is rewritten (#242), so sending someone to check their
 * application config would send them to a file that is already correct. The
 * distinction is the whole reason this is worth saying rather than warning
 * generically about a moved port.
 */
export function staleTerminalNote(stale: readonly StaleTerminalEnv[]): string | null {
    if (stale.length === 0) return null;
    const one = stale.length === 1;
    const named = stale.map((s) => `${s.terminalId} (${s.keys.join(', ')})`).join(', ');
    return (
        `${one ? 'One open terminal was' : `${stale.length} open terminals were`} spawned before this ` +
        `address and still ${one ? 'carries' : 'carry'} the old one: ${named}. A pty's environment cannot be ` +
        `rewritten after it starts, so open a NEW terminal (or restart the agent in it) to inherit the ` +
        `current values. This affects only the client tools a shell runs by hand — psql, mysql — not the ` +
        `application: its configuration is read from the repo's \`.env\`, which Genie has already rewritten.`
    );
}

/**
 * One open terminal that never received a service the workspace publishes.
 *
 * A different state from {@link StaleTerminalEnv}, deliberately, because it
 * MEANS something different: nothing this terminal holds is wrong, it is simply
 * missing a service that was provisioned after it spawned. See
 * {@link incompleteServiceTerminals}.
 */
export interface IncompleteTerminalEnv {
    terminalId: string;
    /** The services whose env never reached it, named and sorted. Empty when
     *  none of the missing keys could be attributed to a service. */
    services: string[];
    /** The missing keys themselves, sorted. */
    keys: string[];
}

/**
 * The open terminals the workspace publishes service env FOR that they never
 * received (genie#540).
 *
 * ## Why this is not a wider {@link staleServiceTerminals}
 *
 * That function's doc comment excludes appeared keys, and is right to: calling
 * a missing value stale would fire on every first `add` and would be describing
 * the wrong thing. But the exclusion left a real case silent. Measured across
 * two workspaces, `printenv` in a terminal of each, neither restarted: one had
 * 3 `GENIE_MAIL_*` and the other had ZERO, with Mailpit running for both. The
 * service was provisioned after that terminal spawned, and a pty's environment
 * cannot be rewritten afterwards — so Genie held both sides and said nothing,
 * which is #222's defect in a second shape.
 *
 * So the two states are reported separately rather than merged:
 *
 *   - **stale** — a value it holds is now wrong or withdrawn. It is dialling
 *     something that moved or is gone. A problem.
 *   - **incomplete** — this. Nothing it holds is wrong. Informational.
 *
 * The remedy is the same today (open a new terminal), which is exactly why they
 * must not share a sentence: conflated, the common informational case shouts
 * and the real one blends into it.
 *
 * ## An ABSENT snapshot is not an empty one
 *
 * A terminal with no entry is skipped, the same as in `staleServiceTerminals`:
 * Genie records what every terminal in a workspace inherits, so no entry means
 * it does not know what that pty got, and a claim about it would be invented.
 * An EMPTY entry is a real observation — that terminal predates the workspace's
 * first service, holds nothing, and is the worst instance of the defect rather
 * than an exception to it.
 */
export function incompleteServiceTerminals(
    live: Record<string, string>,
    openTerminalIds: readonly string[],
): IncompleteTerminalEnv[] {
    const out: IncompleteTerminalEnv[] = [];
    for (const terminalId of [...openTerminalIds].sort()) {
        const had = snapshots.get(terminalId);
        if (!had) continue;
        // NOT `live[key] !== had[key]` — that is staleness, and a key whose
        // value merely differs is one this terminal DID receive. Only a key it
        // never had at all is missing.
        const keys = Object.keys(live)
            .filter((key) => !(key in had))
            .sort();
        if (keys.length === 0) continue;
        const services = groupEnvKeysByService(keys, live)
            .map((group) => group.service)
            .filter((service): service is string => service !== null);
        out.push({ terminalId, services, keys });
    }
    return out;
}

/**
 * What to tell the caller, or null when there is nothing to say.
 *
 * INFORMATIONAL, and worded so it cannot be mistaken for the stale note: it
 * says the value is missing rather than wrong, and it says — for the same
 * reason {@link staleTerminalNote} does — that the application is unaffected,
 * because its configuration comes from the repo's `.env` (#242). Without that
 * sentence somebody goes looking for a broken app that is fine.
 *
 * Names the SERVICE rather than the keys wherever it can. "This terminal
 * predates Mailpit" is actionable; three `GENIE_MAIL_*` names make the reader
 * do the grouping. The keys are the fallback for a service Genie cannot name.
 */
export function incompleteTerminalNote(
    incomplete: readonly IncompleteTerminalEnv[],
): string | null {
    if (incomplete.length === 0) return null;
    const one = incomplete.length === 1;
    const named = incomplete
        .map((t) => `${t.terminalId} (${(t.services.length ? t.services : t.keys).join(', ')})`)
        .join(', ');
    return (
        `${
            one
                ? 'One open terminal predates a service'
                : `${incomplete.length} open terminals predate services`
        } this workspace publishes and never received ${one ? 'its' : 'their'} environment: ` +
        `${named}. Nothing ${one ? 'it holds' : 'they hold'} is wrong — the value is MISSING, not ` +
        `moved — and the application is unaffected either way: its configuration is read from the ` +
        `repo's \`.env\`, which Genie keeps current. A pty's environment is fixed at spawn, so open ` +
        `a NEW terminal (or restart the agent in it) if a shell here needs to reach ` +
        `${one ? 'that service' : 'those services'} by hand.`
    );
}

/**
 * Both terminal-env notes for one workspace, shaped for a `ManageServiceResult`
 * — each field present only when there is something to say.
 *
 * PURE: the caller supplies the live env (already narrowed to the form a
 * terminal is handed) and the ids of the terminals that are actually open. That
 * leaves the MCP layer with nothing but the I/O, which is the part no unit test
 * can reach.
 *
 * A terminal can be BOTH — its Postgres moved AND it predates Mailpit — and
 * then it is named twice, once per fact. That is the point of the split: the
 * remedy is the same reopen either way, but "you are dialling an address that
 * moved" and "you never got this one" are not the same sentence, and merging
 * them makes the common informational case shout.
 */
export function terminalEnvNotes(
    live: Record<string, string>,
    openTerminalIds: readonly string[],
): { note?: string; terminalsMissingEnv?: string } {
    const stale = staleTerminalNote(staleServiceTerminals(live, openTerminalIds));
    const missing = incompleteTerminalNote(
        incompleteServiceTerminals(live, openTerminalIds),
    );
    return {
        ...(stale ? { note: stale } : {}),
        ...(missing ? { terminalsMissingEnv: missing } : {}),
    };
}
