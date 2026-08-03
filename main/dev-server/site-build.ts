import { redactSecrets } from '../workspace/git-auth';
import type { CommandResult, ExecOptions } from './container-runtime';
import type { BuildStep } from './serve-recipe';

/**
 * THE PRODUCTION BUILD — the stage that makes "hosting" different from "running
 * a dev server".
 *
 * ## Where it runs, and why it is not the site's own container
 *
 * The build `exec`s into the workspace's long-lived SANDBOX container. That is
 * the container with the toolchain in it — Node, PHP, Python, Go, Rust — and the
 * site's own container very often has none of them: a PHP site serves from
 * FrankenPHP and a built front end serves from nginx, and neither image contains
 * a compiler. Splitting build from serve is not an implementation detail; it is
 * what production actually does.
 *
 * The two containers share exactly one thing, the workspace bind mount, which is
 * why every artifact path in `serve-recipe.ts` is a path under the repo rather
 * than container-local scratch space. Build in one container, serve from the
 * other, through the mount.
 *
 * ## Required versus optional
 *
 * A required step that fails STOPS the build. This is the rule that keeps a
 * preview honest: a failed `composer install` followed by a server that starts
 * anyway is a site quietly serving the previous build's vendor directory, and
 * everything Genie measures would report it as healthy. An optional step may
 * fail and be reported — `collectstatic` on a project with no `STATIC_ROOT` is a
 * normal outcome, not a reason to refuse to host.
 *
 * ## Nothing throws
 *
 * The same house rule as `site-manager.ts`, for the same reason: this is driven
 * by an MCP agent, and an exception crossing that boundary becomes a tool error
 * with the build log discarded — which is the one piece of information the
 * caller needed.
 */

/**
 * How long any ONE build step gets.
 *
 * Generous on purpose. A cold `cargo build --release`, a `composer install` with
 * no warm cache or an `npm ci` on a large lockfile all legitimately run for many
 * minutes, and a build killed at the wrong moment leaves a half-written artifact
 * that the server will then happily serve.
 */
export const BUILD_STEP_TIMEOUT_MS = 20 * 60 * 1000;

export interface SiteBuildDeps {
    /** The runtime's `exec`, bound to whichever runtime is driving. */
    exec: (id: string, argv: string[], opts?: ExecOptions) => Promise<CommandResult>;
    /** The workspace SANDBOX container — where the toolchain lives. */
    containerId: string;
    /** The repo directory inside the container. Both build and serve use it. */
    workdir: string;
    /** The environment the SERVER will get, given to the build as well. */
    env?: Record<string, string>;
    /**
     * Secret substrings to REDACT from every line of captured/surfaced output —
     * the build log is shown in the UI verbatim, and the build env carries the
     * managed GitHub token (COMPOSER_AUTH / GITHUB_TOKEN, see `build-auth.ts`).
     * A tool that echoes its environment, or a git URL with the token inline,
     * would otherwise leak it into the log. `[]`/absent = nothing to scrub.
     */
    secrets?: string[];
    /** Live output, line by line, for whatever is showing progress. */
    onProgress?: (chunk: string) => void;
}

export interface SiteBuildStepResult {
    label: string;
    command: string[];
    ok: boolean;
    /** True when a failure was tolerated because the step was optional. */
    skipped?: boolean;
    code: number | null;
}

export interface SiteBuildResult {
    ok: boolean;
    steps: SiteBuildStepResult[];
    /** Every step's header and output, in order. Kept on success too — a green
     *  build that installed the wrong thing is still worth being able to read. */
    log: string;
    /** Set when `ok` is false: the step that failed, and what it said. */
    error?: string;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Enough of a chatty build log to diagnose from, without pasting a novel. */
const STEP_OUTPUT_LIMIT = 8_000;

function outputOf(result: CommandResult): string {
    return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

export async function runSiteBuild(
    steps: readonly BuildStep[],
    deps: SiteBuildDeps,
): Promise<SiteBuildResult> {
    const done: SiteBuildStepResult[] = [];
    const log: string[] = [];

    // Every string that lands in the log or a progress chunk passes through
    // here, so a token injected into the build env (see `build-auth.ts`) can
    // never reach the UI-visible build log. A no-op when there is nothing to
    // scrub (the public-build / no-token path).
    const secrets = deps.secrets ?? [];
    const scrub = (text: string): string => (secrets.length ? redactSecrets(text, secrets) : text);

    for (const step of steps) {
        const header = scrub(`$ ${step.command.join(' ')}   # ${step.label}`);
        log.push(header);
        deps.onProgress?.(`${header}\n`);

        let result: CommandResult;
        try {
            result = await deps.exec(deps.containerId, step.command, {
                workdir: deps.workdir,
                ...(deps.env && Object.keys(deps.env).length ? { env: deps.env } : {}),
                timeoutMs: BUILD_STEP_TIMEOUT_MS,
            });
        } catch (e) {
            // The runtime itself failed (the daemon stopped, the container is
            // gone). Reported as a failed STEP so the caller still gets the log
            // of everything that succeeded before it.
            const message = scrub(messageOf(e));
            log.push(message);
            done.push({ label: step.label, command: [...step.command], ok: false, code: null });
            return {
                ok: false,
                steps: done,
                log: log.join('\n'),
                error: `Build step "${step.label}" could not run: ${message}`,
            };
        }

        const output = scrub(outputOf(result).slice(0, STEP_OUTPUT_LIMIT));
        if (output) {
            log.push(output);
            deps.onProgress?.(`${output}\n`);
        }

        const ok = result.code === 0;
        done.push({
            label: step.label,
            command: [...step.command],
            ok,
            ...(ok ? {} : { skipped: Boolean(step.optional) }),
            code: result.code,
        });

        if (ok) continue;
        if (step.optional) {
            const note = `(optional step "${step.label}" failed with exit ${result.code}; hosting continues)`;
            log.push(note);
            deps.onProgress?.(`${note}\n`);
            continue;
        }
        return {
            ok: false,
            steps: done,
            log: log.join('\n'),
            // The STEP is named, because "the build failed" is not something an
            // agent — or a person — can act on.
            error: `Build step "${step.label}" failed (exit ${result.code}): ${
                output || 'no output'
            }`,
        };
    }

    return { ok: true, steps: done, log: log.join('\n') };
}
