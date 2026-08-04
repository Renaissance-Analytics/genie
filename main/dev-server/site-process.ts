import type { ContainerRuntime } from './container-runtime';

/**
 * A hosted site's process, inside the workspace sandbox.
 *
 * The new model has no per-site container: a site is the user's `command` run as
 * a DETACHED process inside the sandbox, in the repo's live-mounted dir. We wrap
 * it in `setsid` so it becomes its own session/process-group leader, record that
 * leader's pid in a tmpfs pidfile, and manage it by pid:
 *   - stop  → `kill -TERM -<pid>` (the negative pid targets the whole GROUP, so
 *             the dev server AND its children die, not just the wrapper); and
 *   - alive → `kill -0 <pid>`.
 *
 * The command + cwd are passed as POSITIONAL args to the wrapper shell, never
 * spliced into the script, so an arbitrary command can't break out of it. The
 * site id (a hex hash) IS interpolated (into the pidfile path), so it is validated
 * first. Never throws — every failure is a result the caller surfaces.
 */

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** tmpfs, not the mounted workspace — pid/log state never touches the user's tree. */
export const SITE_RUN_DIR = '/run/genie-site';

/** Site ids are `devSiteIdFor` hashes; anything else must never reach the shell. */
const SITE_ID_RE = /^[A-Za-z0-9_-]+$/;

function pidPath(siteId: string): string {
    return `${SITE_RUN_DIR}/${siteId}.pid`;
}
function logPath(siteId: string): string {
    return `${SITE_RUN_DIR}/${siteId}.log`;
}

export type SiteProcessResult = { ok: true } | { ok: false; error: string };

export interface StartSiteProcessDeps {
    runtime: ContainerRuntime;
    containerId: string;
    siteId: string;
    /** The user command argv (validated upstream by cleanArgv). */
    command: string[];
    /** Where to run it: the repo's dir inside the sandbox (`/workspace/repos/<repo>`). */
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
}

/**
 * Start a site's command detached in the sandbox and record its pid. Returns
 * quickly (the wrapper backgrounds the command and exits); the command keeps
 * running, reparented to the sandbox's init.
 */
export async function startSiteProcess(deps: StartSiteProcessDeps): Promise<SiteProcessResult> {
    const { runtime, containerId, siteId, command, cwd } = deps;
    if (!SITE_ID_RE.test(siteId)) {
        return { ok: false, error: `refusing unsafe site id ${JSON.stringify(siteId)}` };
    }
    if (!Array.isArray(command) || command.length === 0) {
        return { ok: false, error: 'site has no command to run' };
    }
    // $1 = cwd, then `shift` leaves "$@" = the command. `setsid … &` detaches it
    // into its own group; `echo $!` records that group-leader pid.
    const script =
        `mkdir -p '${SITE_RUN_DIR}'; ` +
        `cd "$1" || exit 1; shift; ` +
        `setsid "$@" >'${logPath(siteId)}' 2>&1 </dev/null & ` +
        `echo "$!" >'${pidPath(siteId)}'`;
    const argv = ['sh', '-c', script, 'genie-site', cwd, ...command];
    try {
        const r = await runtime.exec(containerId, argv, {
            ...(deps.env ? { env: deps.env } : {}),
            timeoutMs: deps.timeoutMs ?? 15_000,
        });
        if (r.code !== 0) {
            const detail = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
            return { ok: false, error: `could not start the site process${detail ? `: ${detail}` : ''}` };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: `could not start the site process: ${messageOf(e)}` };
    }
}

/** Stop a site's process group (best-effort) and drop its pidfile. */
export async function stopSiteProcess(
    runtime: ContainerRuntime,
    containerId: string,
    siteId: string,
): Promise<void> {
    if (!SITE_ID_RE.test(siteId)) return;
    const p = pidPath(siteId);
    const script =
        `p="$(cat '${p}' 2>/dev/null)"; ` +
        // Negative pid → the whole process GROUP (setsid made the pid the pgid).
        `[ -n "$p" ] && kill -TERM -"$p" 2>/dev/null; ` +
        `rm -f '${p}'; true`;
    await runtime.exec(containerId, ['sh', '-c', script], { timeoutMs: 10_000 }).catch(() => {});
}

/** Whether a site's recorded process is still alive. */
export async function siteProcessAlive(
    runtime: ContainerRuntime,
    containerId: string,
    siteId: string,
): Promise<boolean> {
    if (!SITE_ID_RE.test(siteId)) return false;
    const p = pidPath(siteId);
    const script = `p="$(cat '${p}' 2>/dev/null)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null`;
    try {
        const r = await runtime.exec(containerId, ['sh', '-c', script], { timeoutMs: 8_000 });
        return r.code === 0;
    } catch {
        return false;
    }
}
