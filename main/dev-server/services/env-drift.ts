/**
 * PURE. A terminal's baked-in service env going stale (genie#222).
 *
 * Genie injects the workspace's service env into a pty at CREATION. A shell's
 * environment cannot be changed afterwards, so when an engine's published port
 * moves — an ephemeral publication, a recreated container — every terminal opened
 * before the change carries a port that no longer exists.
 *
 * That is worse than a stale readout, because Laravel's dotenv is IMMUTABLE: an
 * already-set variable beats the app's own `.env`. The terminal silently overrides
 * correct configuration, `php artisan migrate` fails with "connection refused"
 * against a healthy database, and — the fingerprint both reporters landed on —
 * `artisan serve` works in the SAME shell, because its passthrough allowlist
 * strips `DB_*` and lets `.env` through.
 *
 * The only remedy is a new terminal. This module is how anybody finds that out.
 */

export interface EnvDrift {
    key: string;
    /** What the terminal is carrying. Redacted when the key names a secret. */
    was: string;
    /** What the workspace has NOW. Absent when the variable is gone entirely. */
    now?: string;
}

/**
 * Keys whose VALUE must never be printed.
 *
 * `DATABASE_URL` is the trap: it looks like an address and is a credential — the
 * password sits in the middle of it. A notice that leaked one while explaining a
 * port change would be a poor trade.
 */
const SECRET_KEY = /(PASSWORD|SECRET|TOKEN|_KEY$|_URL$|URI$)/i;

const show = (key: string, value: string): string =>
    SECRET_KEY.test(key) ? '<redacted>' : value;

/**
 * What a terminal is carrying that the workspace no longer agrees with.
 *
 * Only keys the terminal ACTUALLY HAS are compared. A service added after the
 * terminal opened is not drift — the terminal simply predates it, and reporting
 * that as a change would be false.
 *
 * Sorted, so a notice does not reshuffle between calls.
 */
export function serviceEnvDrift(
    baked: Record<string, string>,
    live: Record<string, string>,
): EnvDrift[] {
    const drift: EnvDrift[] = [];
    for (const key of Object.keys(baked).sort()) {
        const was = baked[key];
        const now = live[key];
        if (was === undefined || now === was) continue;
        drift.push({
            key,
            was: show(key, was),
            ...(now === undefined ? {} : { now: show(key, now) }),
        });
    }
    return drift;
}

/**
 * The sentence to put in front of somebody debugging a connection failure.
 *
 * Null when there is no drift, so a clean answer stays clean.
 *
 * It has to say two things beyond the values. That a stale variable BEATS a
 * correct `.env` — without it the reader assumes their `.env` wins and goes
 * looking somewhere else, which is precisely the time both reporters lost. And
 * that a NEW TERMINAL is the remedy: a shell's environment cannot be changed after
 * it starts, so "restart the service" would send someone in a circle.
 */
export function driftNotice(drift: EnvDrift[]): string | null {
    if (drift.length === 0) return null;
    const lines = drift.map(
        (d) => `  ${d.key}: this terminal has ${d.was}, the workspace now has ${d.now ?? '(nothing — the service is gone)'}`,
    );
    return (
        `This terminal's service environment is STALE — it was set when the terminal opened, and it has changed since:\n${lines.join('\n')}\n` +
        'A running shell cannot be given new environment variables, so this cannot be repaired in place: ' +
        'open a NEW terminal in this workspace. Until you do, note that these values OVERRIDE the ' +
        'application\'s own .env in frameworks whose dotenv is immutable (Laravel among them), so a correct ' +
        '.env will not save you — which is why the failure looks like a broken database rather than a stale shell.'
    );
}
