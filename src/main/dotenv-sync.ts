import { join } from 'node:path';
import { dotEnvServiceVars, dotEnvTargets, envFileName, parseDotEnv, upsertDotEnv } from '../core/dotenv.js';

/**
 * THE SERVICE CONNECTION, KEPT CURRENT IN EACH SITE REPO'S `.env` (§6.6, hosting ship line H4) — the main-process
 * half over core/dotenv.ts.
 *
 * Run whenever what it is built from may have moved: an engine added, made active, started or stopped (the
 * registry's `onChange`), a site added or removed (the site manager's), and once at boot. Each pass compares, and
 * writes only a file whose managed keys differ — so a pass that finds everything current costs reads, no writes and
 * no git call. A port or credential that changes is rewritten on the next pass.
 *
 * NEVER INTO A FILE GIT WOULD COMMIT. Before any write, git is asked (`git check-ignore`, in the `.env`'s own
 * folder) whether the file is ignored. Git's answer covers what a hand-rolled `.gitignore` reader would miss: a
 * parent's `.gitignore`, `info/exclude`, the global excludes — and a `.env` git already TRACKS, which `check-ignore`
 * reports as not ignored (git documents that tracked files are not subject to exclude rules). Not ignored, or not a
 * git repository git can answer for: the write is REFUSED, the file is left exactly as it is, and the refusal says
 * how to fix it. Genie does not edit the person's `.gitignore` for them.
 *
 * A failure is an outcome, never a throw: an unwritable `.env` must not fail an engine's start.
 */

export type GitIgnoreAnswer = 'ignored' | 'not-ignored' | 'no-repo';

export interface DotEnvSyncPorts {
    /** The workspace's service env, as its processes get it. */
    readonly envFor: (workspaceId: string) => Readonly<Record<string, string>>;
    /** Every site Genie knows, by workspace and the folder it serves from. */
    readonly sites: () => readonly { readonly workspaceId: string; readonly repoPath: string }[];
    readonly fs: {
        /** The file's text, or `null` when it does not exist. */
        readText(path: string): Promise<string | null>;
        /** Replace the file whole (temp + rename). */
        writeTextAtomic(path: string, text: string): Promise<void>;
    };
    /** Does git ignore `file` (a name) in `dir`? */
    readonly gitIgnored: (dir: string, file: string) => Promise<GitIgnoreAnswer>;
    /**
     * The env file name the workspace was registered with (`WorkspaceRecord.envFile`, from Settings → General "Env file
     * name"). `undefined` — a workspace from before the setting, or no lookup — is `.env`, which is what this always wrote.
     */
    readonly envFileOf?: (workspaceId: string) => string | undefined;
    readonly log?: (line: string) => void;
}

export type DotEnvOutcome =
    | { readonly workspaceId: string; readonly file: string; readonly outcome: 'written'; readonly keys: readonly string[] }
    | { readonly workspaceId: string; readonly file: string; readonly outcome: 'current' }
    | { readonly workspaceId: string; readonly file: string; readonly outcome: 'refused' | 'failed'; readonly reason: string };

type Exec = (binary: string, args: readonly string[], options?: { timeoutMs?: number; cwd?: string }) => Promise<{ stdout: string; exitCode: number }>;

/**
 * `git check-ignore -q -- <file>` in `dir`: exit 0 = ignored, 1 = not ignored (a tracked file included), anything
 * else (128: not a repository; git missing) = git cannot answer, which is not "ignored".
 */
export function gitIgnoredOver(exec: Exec): DotEnvSyncPorts['gitIgnored'] {
    return async (dir, file) => {
        try {
            const r = await exec('git', ['check-ignore', '-q', '--', file], { cwd: dir, timeoutMs: 10_000 });
            return r.exitCode === 0 ? 'ignored' : r.exitCode === 1 ? 'not-ignored' : 'no-repo';
        } catch {
            return 'no-repo';
        }
    };
}

export class DotEnvSync {
    readonly #ports: DotEnvSyncPorts;
    #queue: Promise<unknown> = Promise.resolve();
    #queued: Promise<DotEnvOutcome[]> | null = null;
    #closed = false;
    /** The last outcome per file — what the Services tab or an agent can be told. */
    readonly #last = new Map<string, DotEnvOutcome>();

    constructor(ports: DotEnvSyncPorts) {
        this.#ports = ports;
    }

    /**
     * One pass over every workspace that has a site. Passes are serialised, and asks that arrive while one is waiting
     * to run share it — a burst of changes is one pass, run after the last of them.
     */
    syncAll(): Promise<DotEnvOutcome[]> {
        if (this.#closed) return Promise.resolve([]);
        if (this.#queued) return this.#queued;
        const run = this.#queue.then(() => {
            this.#queued = null;
            return this.#closed ? [] : this.#pass();
        });
        this.#queued = run;
        this.#queue = run.catch(() => undefined);
        return run;
    }

    /**
     * No pass starts after this, not even one already queued; resolves once the pass in flight has ended. Genie's
     * shutdown awaits it, so quitting never leaves a `.env` half written or a `git check-ignore` running in a site
     * repo (on Windows, a process whose working directory is the folder keeps it from being moved or removed).
     */
    close(): Promise<void> {
        this.#closed = true;
        return this.#queue.then(() => undefined);
    }

    /** The last outcome for each `.env` Genie has looked at. */
    outcomes(): DotEnvOutcome[] {
        return [...this.#last.values()];
    }

    async #pass(): Promise<DotEnvOutcome[]> {
        const sites = this.#ports.sites();
        const out: DotEnvOutcome[] = [];
        for (const workspaceId of new Set(sites.map((s) => s.workspaceId))) {
            // An empty env is "nothing provisioned yet", never "clear the file".
            const vars = dotEnvServiceVars(this.#ports.envFor(workspaceId));
            if (Object.keys(vars).length === 0) continue;
            for (const dir of dotEnvTargets(sites, workspaceId)) {
                const outcome = await this.#write(workspaceId, dir, vars);
                this.#last.set(outcome.file, outcome);
                if (outcome.outcome === 'refused' || outcome.outcome === 'failed') this.#ports.log?.(`[env] ${outcome.file}: ${outcome.reason}`);
                out.push(outcome);
            }
        }
        return out;
    }

    async #write(workspaceId: string, dir: string, vars: Record<string, string>): Promise<DotEnvOutcome> {
        const recorded = this.#ports.envFileOf?.(workspaceId);
        const name = envFileName(recorded);
        if (name === null) {
            return {
                workspaceId,
                file: join(dir, String(recorded)),
                outcome: 'refused',
                reason: `the service connection was NOT written: the workspace's env file ${JSON.stringify(recorded)} is not a file name in ${dir} (no folders, no "..")`,
            };
        }
        const file = join(dir, name);
        try {
            const before = (await this.#ports.fs.readText(file)) ?? '';
            const after = upsertDotEnv(before, vars);
            if (after === before) return { workspaceId, file, outcome: 'current' };
            const ignored = await this.#ports.gitIgnored(dir, name);
            if (ignored !== 'ignored') {
                const why = ignored === 'no-repo'
                    ? `${dir} is not a git repository git could answer for, so Genie cannot confirm the file would never be committed`
                    : 'git does not ignore it (or already tracks it)';
                return {
                    workspaceId,
                    file,
                    outcome: 'refused',
                    reason: `the service connection (with its password) was NOT written: ${why}. Add \`${name}\` to the repository’s .gitignore (and \`git rm --cached ${name}\` if git tracks it); Genie writes it on the next change. The file was left as it was.`,
                };
            }
            await this.#ports.fs.writeTextAtomic(file, after);
            const was = parseDotEnv(before);
            const keys = Object.keys(vars).filter((k) => was.get(k) !== vars[k]);
            return { workspaceId, file, outcome: 'written', keys };
        } catch (error) {
            return { workspaceId, file, outcome: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
    }
}
