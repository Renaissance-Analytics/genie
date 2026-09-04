/**
 * WHICH OPEN TERMINALS ARE STILL DIALLING THE OLD SERVICE ADDRESS (genie#222).
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
