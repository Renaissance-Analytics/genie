import { containerPlan, SERVICE_CATALOG, type Credentials, type CustomEngineSpec, type EngineAdmin, type ServiceScope } from '../core/services.js';
import { randomUUID } from 'node:crypto';
import { maskUpdateFailure, parseUpdateContainer, recreateServiceArgs, updateFingerprint } from '../core/service-update.js';

export type ServiceImageUpdate = { kind: 'needs-consent'; image: string; note: string } | { kind: 'updated'; image: string; restarted: boolean };

/**
 * SERVICE ENGINES — the Docker driver (§6.6).
 *
 * Every effect is a `docker` invocation through an injected runner (execFile in production, a fake
 * in tests). Pulls happen only with CONSENT — an image is a download the person should know about.
 * A container is created from `containerPlan` (loopback-only publishing, engine-keyed name and
 * volume). Status is READ from `docker inspect` on every ask, never remembered. Removing a container
 * keeps its data volume unless asked: switching versions never destroys data. `exec` runs an engine's own
 * client inside its container — how a workspace's slice of a shared engine is made (core/service-provision.ts).
 * `logs` reads the end of the container's output, bounded (hosting ship line H6): it exists to explain something, not
 * to dump an engine's whole history into a window.
 */

/**
 * `stdout` is what came out (stderr when stdout was empty). `streams` is both, as written, when the runner has them —
 * the production runner always does; a log read needs it, because an engine may write only to stderr.
 */
export type DockerRunner = (args: readonly string[]) => Promise<{ stdout: string; exitCode: number; streams?: { readonly stdout: string; readonly stderr: string } }>;

/** How long one `docker` call may take. A pull downloads an image (postgres:17 is ~150 MB): minutes, not seconds. */
export const DOCKER_PULL_TIMEOUT_MS = 15 * 60_000;
/**
 * A command that CHANGES a container — create, start, stop (which itself waits 10 s for the engine to shut down), rm,
 * exec, update — on a loaded machine. Tynn #789: moic's acceptance re-adding pgvector on its kept volume was cut at the
 * old single 20 s bound and read as a failed add. A cut change is READ BACK (`create`, `start`), never assumed failed.
 */
export const DOCKER_CHANGE_TIMEOUT_MS = 2 * 60_000;
/** An inspection — version, image/container inspect, ps, logs — answers in seconds or the daemon is wedged. */
export const DOCKER_QUERY_TIMEOUT_MS = 20_000;

const DOCKER_QUERIES: ReadonlySet<string> = new Set(['version', 'image', 'container', 'ps', 'logs', 'info']);

/** The exit code a runner answers when the `docker` binary is not on this machine (the shell's own "command not found"). */
export const DOCKER_NOT_INSTALLED_EXIT = 127;

/** Genie 1's DEFAULT_LOG_TAIL (argv.ts): how many lines a log read gives when none is asked for. */
export const DEFAULT_LOG_TAIL = 500;
/** The most any read gives, whatever is asked: the answer crosses IPC and MCP, and a log is read, not archived. */
export const MAX_LOG_TAIL = 5000;

/** A tail that is a whole number of lines from 1 to MAX_LOG_TAIL; nothing (or not a number) asked for is the default. */
export function logTail(asked?: number): number {
    if (asked === undefined || !Number.isFinite(asked)) return DEFAULT_LOG_TAIL;
    return Math.min(MAX_LOG_TAIL, Math.max(1, Math.floor(asked)));
}

/** Where an image is pulled from, for the consent note: the registry its name starts with, else Docker Hub. */
export function registryOf(image: string): string {
    const first = image.split('/')[0] ?? '';
    return image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : 'Docker Hub';
}

export function dockerTimeoutMs(args: readonly string[]): number {
    if (args[0] === 'pull') return DOCKER_PULL_TIMEOUT_MS;
    return DOCKER_QUERIES.has(args[0] ?? '') ? DOCKER_QUERY_TIMEOUT_MS : DOCKER_CHANGE_TIMEOUT_MS;
}

type Exec = (binary: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<{ stdout: string; exitCode: number; streams?: { readonly stdout: string; readonly stderr: string } }>;

/**
 * The production `docker` runner over a command runner (execFileRunner): ONLY a pull gets the long bound — the
 * runner's 20 s default killed every Postgres/MySQL pull mid-download, and a cut pull reads as a failed add. A
 * missing binary answers exit 127 and a timeout answers 124 with the runner's words, never a throw: callers
 * read the exit code, and `available()` reads 127 as "not installed".
 */
export function dockerRunnerOver(exec: Exec): DockerRunner {
    return (args) =>
        exec('docker', args, { timeoutMs: dockerTimeoutMs(args) }).catch((e: unknown) => {
            const code = (e as { code?: unknown } | null)?.code;
            const message = e instanceof Error ? e.message : String(e);
            if (code === 'ETIMEDOUT') {
                // WHICH command, and its bound: "docker did not answer" named neither (moic run 12).
                const sub = args[0] === 'image' || args[0] === 'container' || args[0] === 'volume' ? args.slice(0, 2).join(' ') : (args[0] ?? '');
                const ms = dockerTimeoutMs(args);
                return { stdout: `docker ${sub} did not answer within ${ms >= 10 * 60_000 ? `${ms / 60_000} min` : `${ms / 1000} s`}`, exitCode: 124 };
            }
            return { stdout: message, exitCode: code === 'ENOENT' ? DOCKER_NOT_INSTALLED_EXIT : 1 };
        });
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z (.*)$/;

/**
 * Two streams of `docker logs --timestamps` lines put back in the order they were written, the stamps removed.
 * Docker's stamps are RFC 3339 with the fraction's trailing zeros trimmed (`…:05.1Z`, `…:05.12Z`), so they are
 * compared with the fraction padded to nine digits, never as text. A line without a stamp keeps its place after the
 * line before it in its own stream. Equal stamps keep stdout first, each stream in its own order.
 */
export function mergeTimestampedLogs(stdout: string, stderr: string): string {
    const lines: { key: string; text: string; stream: number; i: number }[] = [];
    [stdout, stderr].forEach((text, stream) => {
        let key = '';
        text.split(/\r?\n/).forEach((line, i, all) => {
            if (i === all.length - 1 && line === '') return;
            const m = STAMP.exec(line);
            if (m) key = `${m[1]}.${(m[2] ?? '').padEnd(9, '0')}`;
            lines.push({ key, text: m ? m[3]! : line, stream, i });
        });
    });
    lines.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.stream - b.stream || a.i - b.i));
    return lines.length === 0 ? '' : `${lines.map((l) => l.text).join('\n')}\n`;
}

/**
 * Where an engine's image keeps its data — the volume goes there. Postgres moved it at 18 (hosting fixes 3.3; measured
 * on omarchy-test, postgres and pgvector alike): 18's image declares VOLUME /var/lib/postgresql (PGDATA
 * /var/lib/postgresql/18/docker) and will not START on the old mount; 17 and before lose every row on the new one.
 */
function dataDirOf(engine: string, major: string): string {
    if (engine === 'postgres' && Number.parseInt(major, 10) >= 18) return '/var/lib/postgresql';
    return DATA_DIRS[engine] ?? '/data';
}

const DATA_DIRS: Record<string, string> = {
    postgres: '/var/lib/postgresql/data',
    mysql: '/var/lib/mysql',
    mariadb: '/var/lib/mysql',
    redis: '/data',
    mongo: '/data/db',
    mailpit: '/data',
    minio: '/data',
    meilisearch: '/meili_data',
    seaweedfs: '/data',
};

export class ServiceDriver {
    readonly #run: DockerRunner;
    readonly #updating = new Set<string>();

    constructor(run: DockerRunner) {
        this.#run = run;
    }

    async available(): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
        try {
            const r = await this.#run(['version', '--format', '{{.Server.Version}}']);
            if (r.exitCode === DOCKER_NOT_INSTALLED_EXIT) return { ok: false, reason: 'Docker is not installed on this machine; service engines need it' };
            if (r.exitCode !== 0 || /cannot connect/i.test(r.stdout)) {
                return { ok: false, reason: 'Docker is installed but its daemon is not running; start Docker Desktop (or dockerd) and try again' };
            }
            return { ok: true, version: r.stdout.trim() };
        } catch {
            return { ok: false, reason: 'Docker is not installed on this machine; service engines need it' };
        }
    }

    async ensureImage(image: string, options: { consent: boolean }): Promise<{ kind: 'present' | 'pulled' | 'needs-consent'; image: string; note?: string }> {
        const have = await this.#run(['image', 'inspect', image]);
        if (have.exitCode === 0) return { kind: 'present', image };
        if (!options.consent) return { kind: 'needs-consent', image, note: `${image} is not on this machine; pulling it downloads the image from ${registryOf(image)}.` };
        const pulled = await this.#run(['pull', image]);
        if (pulled.exitCode !== 0) throw new Error(pulled.stdout.trim() || `docker pull ${image} failed`);
        return { kind: 'pulled', image };
    }

    /** Pull FIRST. Keep the old container until replacement and credential restoration succeed, for rollback. */
    async update(name: string, options: { consent: boolean; afterStart?: () => Promise<void>; beforeStop?: () => void }): Promise<ServiceImageUpdate> {
        if (this.#updating.has(name)) throw new Error(`${name} is already being updated; wait for that update to finish`);
        if (!options.consent) return this.#update(name, options);
        this.#updating.add(name);
        try { return await this.#update(name, options); }
        finally { this.#updating.delete(name); }
    }

    async #update(name: string, options: { consent: boolean; afterStart?: () => Promise<void>; beforeStop?: () => void }): Promise<ServiceImageUpdate> {
        const inspected = await this.#run(['container', 'inspect', name]);
        if (inspected.exitCode !== 0) throw new Error(`cannot inspect ${name}; nothing was updated`);
        const before = parseUpdateContainer(inspected.stdout);
        const args = recreateServiceArgs(name, before);
        const token = randomUUID();
        const ownerLabel = 'ai.genie.service-update';
        args.splice(args.indexOf('--entrypoint'), 0, '--label', `${ownerLabel}=${token}`);
        const image = before.Config!.Image!;
        if (!options.consent) return { kind: 'needs-consent', image, note: `Pull ${image} fresh from ${registryOf(image)} and recreate this engine, keeping its name, volumes, ports and credentials. A running engine is interrupted; a stopped one stays stopped.` };
        const checked = async (argv: readonly string[]) => {
            const r = await this.#run(argv);
            if (r.exitCode !== 0) throw new Error(maskUpdateFailure(r.stdout.trim() || `docker ${argv[0]} failed (exit ${r.exitCode})`, before));
        };
        await checked(['pull', image]);
        const now = await this.#run(['container', 'inspect', name]);
        if (now.exitCode !== 0 || updateFingerprint(parseUpdateContainer(now.stdout)) !== updateFingerprint(before)) throw new Error('The engine changed while its image was downloading; nothing was replaced. Review it and try again.');
        options.beforeStop?.();
        const backup = `${name}-before-update-${randomUUID()}`;
        const running = before.State!.Status === 'running';
        let originalName = name;
        const inspect = async (key: string) => {
            const r = await this.#run(['container', 'inspect', key]);
            if (r.exitCode === 0) return parseUpdateContainer(r.stdout);
            if (/no such (container|object)/i.test(r.stdout)) return null;
            throw new Error(maskUpdateFailure(`Docker could not locate ${key}: ${r.stdout.trim()}`, before));
        };
        try {
            if (running) await this.stop(name);
            await checked(['rename', name, backup]);
            originalName = backup;
            await checked(args);
            if (running) {
                await this.start(name);
                await options.afterStart?.();
                if ((await this.status(name)).state !== 'running') throw new Error('the replacement exited instead of staying running');
            }
        } catch (error) {
            try {
                // Read back even a failed/timed-out rename: Docker may have changed the name before the cut.
                const saved = await inspect(backup);
                const current = await inspect(name);
                if (saved?.Id === before.Id) {
                    originalName = backup;
                    if (current) {
                        // Only this operation's replacement. Another process may have claimed the name.
                        if (current.Config?.Labels?.[ownerLabel] !== token) throw new Error(`the name ${name} is held by an unrelated container; it was left untouched`);
                        await checked(['rm', '-f', name]);
                    }
                    await checked(['rename', backup, name]);
                    originalName = name;
                } else if (current?.Id !== before.Id) {
                    throw new Error('Docker did not show the original container under its saved or original name');
                }
                if (running) {
                    await this.start(name);
                    // A stop discarded Redis's in-memory ACLs even when the old container was restored.
                    await options.afterStart?.();
                }
            } catch (rollback) {
                throw new Error(maskUpdateFailure(`Update failed: ${(error as Error).message}. Restoring the original failed: ${(rollback as Error).message}. The original container is kept as ${originalName}; its volumes were not deleted.`, before));
            }
            throw new Error(maskUpdateFailure(`Update failed: ${(error as Error).message}. The original container was restored; its volumes were not deleted.`, before));
        }
        // A cleanup failure does not undo a working replacement. Name the retained backup for recovery.
        try { await checked(['rm', '-f', backup]); }
        catch (error) { throw new Error(maskUpdateFailure(`The engine was updated, but the stopped backup ${backup} could not be removed: ${(error as Error).message}`, before)); }
        return { kind: 'updated', image, restarted: running };
    }

    /** `configFile`: the host file an engine that reads its tenants from one (Sockudo) is given, read-only. */
    async create(input: { engine: string; major: string; scope: ServiceScope; publishedPort: number; credentials?: Credentials; admin?: EngineAdmin; surfacePorts?: Readonly<Record<string, number>>; custom?: CustomEngineSpec; configFile?: string; variant?: string }): Promise<{ ok: true; name: string; existed?: true } | { ok: false; reason: string }> {
        const plan = containerPlan(input);
        const existing = await this.#run(['container', 'inspect', plan.name]);
        if (existing.exitCode === 0) {
            // ALREADY THERE (hosting fixes 3.1): adopted only as it was made. Recording other credentials or another port
            // over it re-keyed it — a workspace that could no longer connect ("password authentication failed").
            const differs = madeDifferently(existing.stdout, plan);
            if (differs === null) return { ok: true, name: plan.name, existed: true };
            return { ok: false, reason: `a container named ${plan.name} is already on this machine, made with ${differs}; Genie left it as it is and recorded nothing. Remove that container in Docker (its data volume stays), then add the engine again` };
        }
        const def = SERVICE_CATALOG.find((e) => e.engine === input.engine)!;
        // `--mount` is comma-separated: a source with a comma would be read as another field, so it is refused, not guessed.
        const bad = (plan.mounts ?? []).find((m) => m.source.includes(','));
        if (bad) return { ok: false, reason: `the config file for ${plan.name} is at a path with a comma (${bad.source}), which Docker's --mount cannot take; nothing was created` };
        const args = ['create', '--name', plan.name];
        // Every surface the plan publishes (Mailpit's SMTP AND its web inbox), each loopback-only.
        for (const p of plan.publish) args.push('-p', p);
        // No volume for a custom image or a stateless engine (Sockudo): `null` in the plan.
        if (plan.volume !== null) args.push('-v', `${plan.volume}:${dataDirOf(def.engine, input.major)}`);
        // `--mount`, not `-v`: a Windows source path's drive colon would split a `-v` spec.
        for (const m of plan.mounts ?? []) args.push('--mount', `type=bind,source=${m.source},target=${m.target},readonly`);
        args.push('--restart', 'unless-stopped');
        // `--entrypoint` takes one word and must precede the image; what it runs follows the image (SeaweedFS's `-c …`).
        if (plan.entrypoint) args.push('--entrypoint', plan.entrypoint);
        for (const [k, v] of Object.entries(plan.env)) args.push('-e', `${k}=${v}`);
        args.push(plan.image, ...(plan.command ?? []));
        const r = await this.#run(args);
        // Cut, not refused: what Docker DID is read back — a container it made is made (Tynn #789).
        if (r.exitCode === 124 && (await this.#run(['container', 'inspect', plan.name])).exitCode === 0) return { ok: true, name: plan.name };
        if (r.exitCode !== 0) return { ok: false, reason: r.stdout.trim() || `docker create ${plan.name} failed (exit ${r.exitCode})` };
        return { ok: true, name: plan.name };
    }

    async start(name: string): Promise<void> {
        const r = await this.#run(['start', name]);
        // Cut, not refused: a container that is running was started (Tynn #789).
        if (r.exitCode === 124 && (await this.status(name)).state === 'running') return;
        if (r.exitCode !== 0) throw new Error(r.stdout.trim() || `docker start ${name} failed`);
    }

    /** `docker exec <name> …argv`: the engine's own client, inside its container. Answers what it said; never throws for a non-zero exit. */
    exec(name: string, argv: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
        return this.#run(['exec', name, ...argv]);
    }

    async stop(name: string): Promise<void> {
        const r = await this.#run(['stop', name]);
        if (r.exitCode !== 0) throw new Error(r.stdout.trim() || `docker stop ${name} failed`);
    }

    async status(name: string): Promise<{ state: 'running'; since: string } | { state: 'exited' } | { state: 'absent' }> {
        const r = await this.#run(['container', 'inspect', name]);
        if (r.exitCode !== 0) return { state: 'absent' };
        try {
            const [info] = JSON.parse(r.stdout) as Array<{ State?: { Status?: string; StartedAt?: string } }>;
            if (info?.State?.Status === 'running') return { state: 'running', since: info.State.StartedAt ?? '' };
            return { state: 'exited' };
        } catch {
            return { state: 'absent' };
        }
    }

    /**
     * The last lines the container wrote (`docker logs --timestamps --tail N`), N bounded by `logTail`. Docker hands
     * the container's stdout and stderr back on its own two streams, and an engine may use only one of them (Postgres
     * logs to stderr alone), so BOTH are read and put back in the order they were written, by Docker's timestamps.
     * Throws with Docker's own words when the container cannot be read (absent, or the daemon down).
     */
    async logs(name: string, tail?: number): Promise<{ text: string; tail: number }> {
        const n = logTail(tail);
        const r = await this.#run(['logs', '--timestamps', '--tail', String(n), name]);
        if (r.exitCode !== 0) throw new Error(r.stdout.trim() || `docker logs ${name} failed (exit ${r.exitCode})`);
        return { text: r.streams ? mergeTimestampedLogs(r.streams.stdout, r.streams.stderr) : mergeTimestampedLogs(r.stdout, ''), tail: n };
    }

    /**
     * `volume` is the instance's own when it has one: an adopted Genie 1 container named its volume itself, and a
     * `delete data` that guessed `<container>-data` would remove nothing and say it had. `null` = it has none (a custom
     * image): nothing to delete. Whether deleting is ALLOWED is decided before this, by the registry
     * (core/service-tenancy.ts) — the driver only does what it is told.
     */
    async remove(name: string, options: { deleteData: boolean; volume?: string | null }): Promise<void> {
        // Docker's answer is read (hosting fixes 3.1): a removal it did not do throws in its words, and the caller keeps its
        // record. What is already gone is removed — a refusal is believed only while the thing is still there.
        const removed = await this.#run(['rm', '-f', name]);
        if (removed.exitCode !== 0 && (await this.#run(['container', 'inspect', name])).exitCode === 0) {
            throw new Error(removed.stdout.trim() || `docker rm ${name} failed (exit ${removed.exitCode})`);
        }
        if (options.deleteData && options.volume !== null) {
            const volume = options.volume ?? `${name}-data`;
            const gone = await this.#run(['volume', 'rm', volume]);
            if (gone.exitCode !== 0 && (await this.#run(['volume', 'inspect', volume])).exitCode === 0) {
                throw new Error(gone.stdout.trim() || `docker volume rm ${volume} failed (exit ${gone.exitCode})`);
            }
        }
    }
}

/**
 * How a container Docker already holds differs from what Genie would make it with (`docker container inspect` output
 * against the plan), in words that name ports and variable NAMES only — never a value, which may be a password. `null`
 * when it was made exactly so: every planned env entry is in its `Config.Env`, every planned port is bound as planned.
 */
export function madeDifferently(inspectJson: string, plan: { readonly env: Record<string, string>; readonly publish: readonly string[] }): string | null {
    let found: { Config?: { Env?: unknown }; HostConfig?: { PortBindings?: unknown } } | undefined;
    try {
        found = (JSON.parse(inspectJson) as unknown[])[0] as typeof found;
    } catch {
        return 'settings Docker would not show';
    }
    const env = new Set(Array.isArray(found?.Config?.Env) ? (found!.Config!.Env as unknown[]).filter((e): e is string => typeof e === 'string') : []);
    const bindings = (found?.HostConfig?.PortBindings ?? {}) as Record<string, { HostPort?: string }[] | null>;
    const said: string[] = [];
    for (const spec of plan.publish) {
        const [, host, inner] = spec.split(':');
        const bound = (bindings[`${inner}/tcp`] ?? []).map((b) => b.HostPort);
        if (!bound.includes(host)) said.push(bound.length > 0 ? `port ${bound.join(', ')} where Genie would use ${host}` : `no port where Genie would use ${host}`);
    }
    const otherVars = Object.entries(plan.env).filter(([k, v]) => !env.has(`${k}=${v}`)).map(([k]) => k);
    if (otherVars.length > 0) said.push(`a different ${otherVars.join(', ')}`);
    return said.length === 0 ? null : said.join(' and ');
}
