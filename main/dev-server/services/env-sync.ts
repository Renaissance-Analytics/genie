import type { DevSites } from '../sites-config';
import type { EnvBlockRequest, EnvBlockResult } from '../../env-store';

/**
 * PURE. What a workspace's provisioned services put into a repo's `.env`, and
 * which `.env` files get it (genie#242).
 *
 * ## The defect this closes
 *
 * Genie injected a service's connection into a TERMINAL's environment at spawn,
 * and nowhere else. Two things were wrong with that.
 *
 * It is invisible to everything not launched from that one terminal — a hosted
 * site, a `manageProcess` worker, a shell the user opened themselves, an editor
 * task. Those read the app's own `.env`, which Genie never wrote, so it said
 * whatever it said the day somebody typed it.
 *
 * And it does not merely go stale, it DEFEATS THE FIX. Laravel's dotenv is
 * immutable: an already-set environment variable beats `.env`. A terminal
 * carrying a `DB_PORT` from before a restart moved the published port overrode a
 * `.env` somebody had just corrected — so the correction did nothing, the error
 * stayed `Connection refused`, and it pointed at the database.
 *
 * The application's own config file is the one thing that has to be right. This
 * module is the plan for making it right; `env-store.ts` performs the write.
 *
 * ## Why the HOST form
 *
 * These values are written for whatever reads the repo's `.env`: a terminal, a
 * `manageProcess` worker, a host-native dev server. All of those run ON THE HOST,
 * so they need the engine's PUBLISHED loopback address. A sandbox site is
 * unaffected — it receives the container-name form as real container environment,
 * computed at start and therefore never stale, and (by the same dotenv rule that
 * caused the bug) that set environment wins over the file.
 */

/**
 * Names that belong to a SHELL rather than to an application.
 *
 * `psql` reads `PG*`, `mysql` reads `MYSQL_*`. Nothing reads them out of a
 * `.env` — they are how an interactive client connects with nothing typed, which
 * is exactly what a terminal still gets. Writing them here would add a second
 * copy of the same credential that no app would ever read.
 */
const CLIENT_TOOL_KEY = /^(PG[A-Z]+|MYSQL_)/;

/**
 * The service env as it should appear in the repo's `.env`.
 *
 * Everything the app's framework reads as its own configuration — `DB_*`,
 * `DATABASE_URL`, `REDIS_*`, `MAIL_*`, `AWS_*`, `REVERB_*`, `MEILISEARCH_*`,
 * a custom service's `GENIE_SERVICE_*` — minus the client-tool duplicates.
 *
 * Takes the HOST-form env (`serviceEnv` over `provisionedForHost`), for the
 * reason in the header.
 */
export function dotEnvServiceVars(hostEnv: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(hostEnv)) {
        if (CLIENT_TOOL_KEY.test(key)) continue;
        out[key] = value;
    }
    return out;
}

/**
 * The `.env` files a workspace's service connection is written to — one per repo
 * the workspace HOSTS A SITE FROM, de-duplicated, as `resolveEnvTarget` names
 * them (a repo name, or `workspace` for a root site).
 *
 * Sites are the join between a workspace-scoped service and a repo-scoped file:
 * a site is Genie being told "this checkout is an app I run", and it is already
 * where site env is written (genie#168 / PR #170). A workspace with no sites gets
 * nothing — scattering database credentials through every checkout under `repos/`
 * on the guess that one of them is an app is not a thing to do to somebody's
 * working tree, and a `.env` Genie invented in a repo that does not read one is
 * pure confusion.
 */
export function dotEnvTargetsFor(sites: DevSites): string[] {
    const targets = new Set<string>();
    for (const site of Object.values(sites)) {
        targets.add(site.repo ? site.repo : 'workspace');
    }
    return [...targets];
}

/**
 * A workspace `.env`, minus the keys GENIE wrote into it.
 *
 * A site's `repo` defaults to `''` — the workspace root — so the file this
 * feature writes is very often `<workspace>/.env`. That file is ALSO loaded
 * wholesale into every terminal's environment (`buildTerminalEnv` →
 * `loadWorkspaceEnvVars`), which exists so a human can set workspace-wide
 * config such as the Tynn token.
 *
 * Without this filter the fix would defeat itself, and more thoroughly than the
 * bug it replaces: Genie writes `DB_PORT` into the file for the app to read, the
 * loader exports it into every shell, and an exported variable outranks `.env` —
 * not merely the root one but EVERY repo's, for anything launched from that
 * terminal. One source of truth means the managed keys live in the FILE and are
 * read from the file.
 *
 * Keyed on the name, not the value: a file that has gone stale is the entire
 * danger, so dropping only exact matches would export precisely the wrong ports.
 * A key Genie does not manage — including the client-tool names — is the user's
 * own and passes straight through.
 */
export function withoutManagedServiceKeys(
    workspaceEnv: Record<string, string>,
    hostEnv: Record<string, string>,
): Record<string, string> {
    const managed = dotEnvServiceVars(hostEnv);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(workspaceEnv)) {
        if (key in managed) continue;
        // ...and the `VITE_` MIRROR of a managed key, which is managed for the
        // same reason under a different spelling. Genie writes the BROWSER
        // endpoint into this file because `VITE_*` is a BUILD-TIME substitution
        // and the file is the only thing a `vite build` reads. Vite then
        // prioritises an inline `process.env.VITE_*` over the file — so a
        // re-exported one from a terminal opened before the endpoint moved would
        // outrank the corrected file and bake the old address into the bundle.
        // That is this filter's whole purpose, arriving under a prefix.
        //
        // Keyed on the managed name, so a VITE_ variable the USER owns
        // (`VITE_APP_NAME`) is theirs and passes straight through.
        if (key.startsWith('VITE_') && key.slice('VITE_'.length) in managed) continue;
        out[key] = value;
    }
    return out;
}

// --- the composition --------------------------------------------------------

export interface ServiceEnvSyncDeps {
    /** Where the workspace lives on disk. `null` ⇒ nothing to write into. */
    workspaceFor: (workspaceId: string) => { path: string } | null;
    devSitesFor: (workspaceId: string) => DevSites;
    /** The workspace's services in HOST form (127.0.0.1:<published port>). */
    hostEnvFor: (workspaceId: string) => Record<string, string>;
    /** The write itself — `env-store.applyEnvBlock` in production. Injected so
     *  the whole decision is testable without touching a disk. */
    write: (workspaceRoot: string, req: EnvBlockRequest) => EnvBlockResult;
    /**
     * A `.env` that could not be written, or was written somewhere it should not
     * stay (a git-tracked file).
     *
     * Tolerating the failure is right — an engine must still come up. Throwing the
     * REASON away is not. Without this the port moves, the file keeps the old one,
     * and the user gets `Connection refused` with nothing to pull on: exactly the
     * silence the terminal-injection bug hid behind.
     */
    onProblem?: (message: string) => void;
}

/**
 * Push a workspace's live service connection into every `.env` it should reach.
 *
 * Called on the SERVICE LIFECYCLE — bound, released, and every time a refresh
 * finds a published port has moved (a Genie restart is one of the things that
 * moves one). That is the second half of the fix: writing the file once at bind
 * time would leave exactly the stale value the issue is about.
 *
 * Never throws, and one unwritable repo never costs the others their update: this
 * runs inside `acquire`, and a `.env` the user has open, made read-only, or a
 * repo that is not checked out must not be able to fail bringing a database up.
 */
export function createServiceEnvSync(deps: ServiceEnvSyncDeps): (workspaceId: string) => void {
    return (workspaceId: string) => {
        try {
            const workspace = deps.workspaceFor(workspaceId);
            if (!workspace?.path) return;

            const vars = dotEnvServiceVars(deps.hostEnvFor(workspaceId));
            // An empty env means "nothing is provisioned yet", NOT "clear the
            // file". Blanking a `.env` because an engine has not come up would be
            // a worse failure than the stale value this exists to fix.
            if (Object.keys(vars).length === 0) return;

            const report = (message: string) => {
                try {
                    deps.onProblem?.(message);
                } catch {
                    /* a listener must never fail a lifecycle call */
                }
            };

            for (const target of dotEnvTargetsFor(deps.devSitesFor(workspaceId))) {
                const label = target === 'workspace' ? '.env' : `repos/${target}/.env`;
                try {
                    const result = deps.write(workspace.path, {
                        ...(target === 'workspace' ? {} : { target }),
                        vars,
                    });
                    if (!result.ok) report(`${result.file ?? label}: ${result.error ?? 'write failed'}`);
                    else if (result.warning) report(result.warning);
                } catch (e) {
                    // One repo's failure is not the others' — but it is still news.
                    report(`${label}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        } catch {
            /* a bookkeeping failure must never fail a service lifecycle call */
        }
    };
}
