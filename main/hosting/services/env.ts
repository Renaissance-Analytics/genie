import type { ServiceInstance } from './types';

/**
 * Turning running services into the configuration a hosted app connects with
 * (Tynn #232, P3).
 *
 * Everything in this file is PURE. That is not incidental: this module decides
 * what gets written into a file inside the USER'S REPOSITORY, so "what would
 * this produce given that input" has to be answerable by a unit test rather
 * than by running it and looking.
 *
 * ## Two delivery paths, on purpose
 *
 * A hosted Laravel app is reached two ways, and only one of them goes through
 * the web server:
 *
 *   1. **The hosted site's own process.** {@link serviceEnvVars} is handed to
 *      FrankenPHP as `HostedSite.env`, so the running app sees the managed
 *      services as ordinary environment variables. Nothing is written anywhere.
 *   2. **The command line** — `php artisan migrate`, `tinker`, `queue:work`.
 *      Those run as separate processes that never touch our web server and see
 *      only the app's `.env`. A migration that cannot find the database is the
 *      first thing anyone tries, so path 2 has to work, and that means writing
 *      to the file.
 *
 * ## The rule for writing that file
 *
 * The user's `.env` is THEIR file, and it is the single most damaging file in a
 * Laravel repository to corrupt — it holds real credentials, and it is usually
 * git-ignored, so a clobbered value is not recoverable from history.
 *
 * So: Genie owns a DELIMITED BLOCK and nothing else. {@link applyManagedEnv}
 * preserves every byte outside its markers, replaces only what is between them,
 * and removes the block entirely when the workspace's services are turned off.
 * It never rewrites, reorders, comments out or deletes a line the user wrote.
 *
 * ## Which value actually wins (measured, not assumed)
 *
 * Verified against Laravel 13 / phpdotenv on 2026-08-01, because the whole
 * design turns on it:
 *
 *   - **Within one `.env`, the LAST assignment wins.** A stock Laravel file
 *     ships a live `DB_CONNECTION=sqlite` and `REDIS_PORT=6379`; with the
 *     managed block appended at the end, `env('DB_CONNECTION')` resolves to
 *     `pgsql`. That is why the block goes at the END — at the top it would be
 *     inert, and the feature would silently do nothing.
 *   - **A real process environment variable beats the file outright.** Setting
 *     `DB_CONNECTION` on the server process wins over every assignment in
 *     `.env`. That is what makes path 1 authoritative for the hosted site.
 *
 * So the block DOES take precedence over a key the user set themselves. Their
 * line is never altered — but its effect is superseded, and that is not
 * something to leave invisible. Every such key is REPORTED
 * ({@link ManagedEnvResult.conflicts}) so the Site Manager can tell the user
 * that their `DB_PASSWORD` is no longer the one in force while hosting is on.
 * Silently overriding a credential that points at a real database — with no
 * record of having done so and no way to see it — is precisely the outcome this
 * design exists to make impossible.
 */

// --- the variables ---------------------------------------------------------

/**
 * PURE. The environment a set of running services implies.
 *
 * CONNECTION DETAILS ONLY. Notably absent are `CACHE_STORE`, `SESSION_DRIVER`
 * and `QUEUE_CONNECTION`: pointing those at redis would change how the app
 * behaves, and "I turned on a cache server" is not consent to move the session
 * store into it. Enabling a service makes it REACHABLE; choosing to use it stays
 * the app's decision.
 *
 * `REDIS_CLIENT` is left alone for a related reason — it selects between the
 * `phpredis` C extension and the `predis` composer package, which is a property
 * of what the app has installed, not of the server we are running.
 */
export function serviceEnvVars(instances: readonly ServiceInstance[]): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const instance of instances) {
        if (instance.kind === 'postgres') {
            vars.DB_CONNECTION = 'pgsql';
            vars.DB_HOST = '127.0.0.1';
            vars.DB_PORT = String(instance.port);
            vars.DB_DATABASE = instance.database ?? 'genie';
            vars.DB_USERNAME = instance.user ?? 'genie';
            vars.DB_PASSWORD = instance.password ?? '';
        }
        if (instance.kind === 'redis') {
            vars.REDIS_HOST = '127.0.0.1';
            vars.REDIS_PORT = String(instance.port);
        }
    }
    return vars;
}

// --- the managed block -----------------------------------------------------

export const MANAGED_BEGIN = '# >>> genie hosting services — managed block, do not edit >>>';
export const MANAGED_END = '# <<< genie hosting services — managed block <<<';

/**
 * PURE. Quote a value only when it needs it.
 *
 * Generated passwords are base64url (see `config.ts#generatePassword`) so in
 * practice nothing here needs quoting — but a database name or a future value
 * might, and an unquoted `#` would silently truncate a value to a comment.
 */
export function quoteEnvValue(value: string): string {
    if (value === '') return '';
    return /^[A-Za-z0-9_.\-:/@]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/** PURE. The block body for a set of variables. */
export function renderManagedEnv(vars: Record<string, string>): string {
    const lines = Object.entries(vars).map(([key, value]) => `${key}=${quoteEnvValue(value)}`);
    return [
        MANAGED_BEGIN,
        '# Written by Genie. Everything outside these markers is yours and is never touched.',
        ...lines,
        MANAGED_END,
    ].join('\n');
}

export interface ManagedEnvResult {
    /** The full new file contents. */
    contents: string;
    /** True when `contents` differs from what was passed in. */
    changed: boolean;
    /**
     * Managed keys the user has ALSO assigned outside the block.
     *
     * Not an error and not something we resolve — a report. See the file header.
     */
    conflicts: string[];
}

/** Matches an assignment to KEY at the start of a line, ignoring `export ` and
 *  leading whitespace, and ignoring comments. */
function assignsKey(line: string, key: string): boolean {
    return new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line);
}

/**
 * PURE. Merge the managed block into an existing `.env`.
 *
 * Passing an empty `vars` REMOVES the block, which is what "disable this
 * workspace's services" has to do — leaving stale credentials for a server that
 * is no longer running would make the app fail with a connection error instead
 * of falling back to whatever it was configured with before.
 */
export function applyManagedEnv(
    existing: string,
    vars: Record<string, string>,
): ManagedEnvResult {
    const keys = Object.keys(vars);
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const lines = existing.split(/\r?\n/);

    const begin = lines.findIndex((l) => l.trim() === MANAGED_BEGIN);
    const end = lines.findIndex((l) => l.trim() === MANAGED_END);
    // Only treat it as a block when BOTH markers are present and ordered. A
    // half-written block (someone deleted the end marker by hand) is left alone
    // and a fresh block appended, rather than eating the rest of the file.
    const hasBlock = begin !== -1 && end !== -1 && end > begin;

    const outside = hasBlock ? [...lines.slice(0, begin), ...lines.slice(end + 1)] : lines;
    const conflicts = keys.filter((key) =>
        outside.some((line) => !line.trim().startsWith('#') && assignsKey(line, key)),
    );

    const block = keys.length ? renderManagedEnv(vars).split('\n') : [];

    let next: string[];
    if (hasBlock) {
        // Replace IN PLACE — the block keeps its position in the file, so a
        // diff of a routine port change is the port line, not a move.
        next = [...lines.slice(0, begin), ...block, ...lines.slice(end + 1)];
        // Removing the block leaves the blank line that separated it; drop one
        // so repeated enable/disable cycles do not grow the file.
        if (!block.length && next[begin - 1]?.trim() === '' && next[begin]?.trim() === '') {
            next.splice(begin, 1);
        }
    } else if (block.length) {
        next = [...lines];
        // A single blank line before the block, unless the file already ends in
        // one (or is empty).
        while (next.length && next[next.length - 1]!.trim() === '') next.pop();
        if (next.length) next.push('');
        next.push(...block, '');
    } else {
        next = lines;
    }

    const contents = next.join(eol);
    return { contents, changed: contents !== existing, conflicts };
}
