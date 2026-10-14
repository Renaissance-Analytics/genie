import { join } from 'node:path';
import { genHost, serveCaddyfile, type DevServer, type ServeSpec } from '../core/serve-config.js';
import type { ProcessSupervisor } from './process-supervisor.js';

/**
 * HOSTED `.gen` SITES (§6.6) — the manager.
 *
 * A site is a NAME, a repo and a serve spec. Genie allocates loopback ports, starts the right
 * processes under the supervisor and publishes `<name>.gen → 127.0.0.1:<port>` for the front
 * door. The three modes (see `core/serve-config.ts`):
 *
 * - **proxy**: the repo's own dev server with `{port}` substituted, or `hostPort` for a server
 *   the user already runs (no process of ours — state `external`).
 * - **static**: Genie's bundled Caddy against a Caddyfile Genie wrote under the config dir.
 * - **php**: a `php-cgi` FastCGI worker first, then Caddy; two ports, two processes, torn down
 *   together.
 *
 * **Agents never write a web-server config.** When the bundled Caddy is not available the site is
 * refused with the fix named; nothing falls back to an inline `printf > nginx.conf`.
 *
 * Site state is DERIVED from the supervisor's view of the main process, never cached: a dead
 * dev server shows the site as not running the moment the supervisor knows.
 */

export type SiteServe =
    | { readonly mode: 'proxy' }
    | { readonly mode: 'static'; readonly root: string; readonly spa: boolean }
    | { readonly mode: 'php'; readonly root: string };

export interface CreateSiteInput {
    readonly name: string;
    readonly workspaceId: string;
    readonly repoPath: string;
    readonly serve: SiteServe;
    /** proxy: the dev server to run (`{port}` substituted). */
    readonly devServer?: DevServer;
    /** proxy: a server the user already runs; no process is started. */
    readonly hostPort?: number;
    /** The service env every process of the site gets. */
    readonly env?: Readonly<Record<string, string>>;
}

/**
 * `unservable`: a site a workspace DECLARES (its project.json) that Genie 2 cannot serve — listed with
 * the reason in `problem`, never started, never routed. Never silently dropped.
 */
export type SiteState = 'running' | 'restarting' | 'stopped' | 'exited' | 'failed' | 'external' | 'unservable';

export interface SiteInfo {
    readonly id: string;
    readonly name: string;
    readonly host: string;
    readonly workspaceId: string;
    readonly repoPath: string;
    /** `null` for an unservable site: there is nothing Genie 2 would serve. */
    readonly serve: SiteServe | null;
    /** The loopback port it is served on; `null` until it has been started once. */
    readonly port: number | null;
    readonly state: SiteState;
    /** Supervisor process ids, main first. Empty for an external site and one never started. */
    readonly processIds: readonly string[];
    /** Why it is not served: an unservable site's reason, or the refusal its last start met. `null` otherwise. */
    readonly problem: string | null;
}

export interface UnservableSiteInput {
    readonly workspaceId: string;
    readonly name: string;
    /** The `.gen` name the declaration asks for, as written. */
    readonly host: string;
    readonly repoPath: string;
    readonly reason: string;
    /** Distinguishes two unservable declarations in one workspace (the envelope's key for it). */
    readonly key: string;
}

export interface SiteManagerDeps {
    readonly supervisor: ProcessSupervisor;
    readonly allocatePort: () => number;
    /** The bundled Caddy, or `null` when this install has none. */
    readonly caddyBin: string | null;
    readonly configDir: string;
    readonly writeConfig: (path: string, content: string) => void;
}

interface SiteRecord {
    readonly input: CreateSiteInput | null;
    readonly unservable: UnservableSiteInput | null;
    readonly id: string;
    readonly host: string;
    port: number | null;
    processIds: readonly string[];
    external: boolean;
    stopped: boolean;
    problem: string | null;
}

export class SiteManager {
    readonly #deps: SiteManagerDeps;
    readonly #sites = new Map<string, SiteRecord>();
    readonly #listeners = new Set<() => void>();

    constructor(deps: SiteManagerDeps) {
        this.#deps = deps;
    }

    /** Declare AND start: a refused start registers nothing. */
    create(input: CreateSiteInput): SiteInfo {
        const record = this.#newRecord(input);
        this.#start(record);
        this.#sites.set(record.id, record);
        this.#changed();
        return this.#info(record);
    }

    /**
     * Know a site WITHOUT starting it — a workspace's declared site that is disabled, asleep, or stopped by
     * the person. Listed as `stopped` until {@link start}. The name is still checked: two sites never share one.
     */
    declare(input: CreateSiteInput): SiteInfo {
        const record = this.#newRecord(input);
        this.#sites.set(record.id, record);
        this.#changed();
        return this.#info(record);
    }

    /** List a declared site Genie 2 cannot serve, with the reason. It is never started and never routed. */
    declareUnservable(input: UnservableSiteInput): SiteInfo {
        const id = `site_${input.workspaceId}_${input.key}`.replace(/[^A-Za-z0-9_-]/g, '_');
        const record: SiteRecord = { input: null, unservable: input, id, host: input.host, port: null, processIds: [], external: false, stopped: true, problem: input.reason };
        this.#sites.set(id, record);
        this.#changed();
        return this.#info(record);
    }

    /**
     * Start a known site that is not running. Throws the reason when it cannot — an unservable site, no
     * bundled Caddy — and keeps that reason on the site (`problem`), so the listing says why it is down.
     */
    start(id: string): SiteInfo {
        const record = this.#sites.get(id);
        if (!record) throw new Error(`no site ${id}`);
        // Its reason stays the problem shown; the refusal names it.
        if (record.unservable) throw new Error(`${record.host} cannot be served by Genie 2: ${record.unservable.reason}`);
        const info = this.#info(record);
        if (info.state === 'running' || info.state === 'restarting' || info.state === 'external') return info;
        try {
            this.#start(record);
        } catch (error) {
            record.problem = error instanceof Error ? error.message : String(error);
            this.#changed();
            throw error;
        }
        this.#changed();
        return this.#info(record);
    }

    #newRecord(input: CreateSiteInput): SiteRecord {
        const host = genHost(input.name);
        for (const s of this.#sites.values()) {
            if (s.host === host) throw new Error(`${host} is already a site (${s.id}); two sites cannot share a name`);
        }
        const id = `site_${host.slice(0, -'.gen'.length)}`;
        return { input, unservable: null, id, host, port: null, processIds: [], external: false, stopped: true, problem: null };
    }

    /** Allocate the ports and start the processes; on a refusal nothing has been started and the record is unchanged. */
    #start(record: SiteRecord): void {
        const input = record.input;
        if (input === null) throw new Error(`${record.host} cannot be served by Genie 2: ${record.problem ?? 'no serve spec'}`);
        const { id, host } = record;
        const proc = (procId: string, name: string, command: string, env: Readonly<Record<string, string>> | undefined) =>
            this.#deps.supervisor.start({ id: procId, workspaceId: input.workspaceId, name, command, cwd: input.repoPath, restart: 'on-failure', ...(env ? { env } : {}) });
        const baseEnv = input.env ? { ...input.env } : undefined;

        if (input.serve.mode === 'proxy') {
            if (input.hostPort !== undefined) {
                Object.assign(record, { port: input.hostPort, processIds: [], external: true });
            } else if (input.devServer) {
                const port = this.#deps.allocatePort();
                const p = String(port);
                // `{port}` in the env too: a dev server that reads PORT is told the port Genie allocated.
                const env = baseEnv ? Object.fromEntries(Object.entries(baseEnv).map(([k, v]) => [k, v.replaceAll('{port}', p)])) : undefined;
                proc(id, `${host} dev server`, input.devServer.command.replaceAll('{port}', p), env);
                Object.assign(record, { port, processIds: [id], external: false });
            } else {
                throw new Error(`a proxy site needs a dev server to run or a hostPort it already listens on; ${input.repoPath} offered neither`);
            }
        } else {
            const caddy = this.#deps.caddyBin;
            if (caddy === null) {
                throw new Error(`a ${input.serve.mode} site is served by Genie's bundled Caddy, which this install does not have; reinstall Genie or serve the repo's own dev server (proxy) instead`);
            }
            const port = this.#deps.allocatePort();
            const processIds: string[] = [];
            let spec: ServeSpec;
            if (input.serve.mode === 'php') {
                const fcgiPort = this.#deps.allocatePort();
                spec = { mode: 'php', root: input.serve.root, fcgiPort };
                // Rendered BEFORE anything starts: a root that escapes the repo is refused with nothing running.
                const caddyfile = serveCaddyfile({ sitePort: port, repoPath: input.repoPath, serve: spec })!;
                proc(`${id}-fcgi`, `${host} php worker`, `php-cgi -b 127.0.0.1:${fcgiPort}`, baseEnv);
                processIds.push(`${id}-fcgi`);
                this.#runCaddy(record, caddy, caddyfile, baseEnv, proc);
            } else {
                spec = input.serve;
                const caddyfile = serveCaddyfile({ sitePort: port, repoPath: input.repoPath, serve: spec })!;
                this.#runCaddy(record, caddy, caddyfile, baseEnv, proc);
            }
            // Main process first in the list: the route's target and the state's source.
            Object.assign(record, { port, processIds: [id, ...processIds], external: false });
        }
        record.stopped = false;
        record.problem = null;
    }

    #runCaddy(record: SiteRecord, caddy: string, caddyfile: string, env: Readonly<Record<string, string>> | undefined, proc: (procId: string, name: string, command: string, env: Readonly<Record<string, string>> | undefined) => unknown): void {
        const configPath = join(this.#deps.configDir, record.id, 'Caddyfile');
        this.#deps.writeConfig(configPath, caddyfile);
        proc(record.id, `${record.host} server`, `${caddy} run --config ${configPath} --adapter caddyfile`, env);
    }

    /** Fires after create, declare, start, stop and remove — what re-renders the external front door's Caddyfile. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    #changed(): void {
        for (const l of this.#listeners) l();
    }

    get(id: string): SiteInfo | null {
        const record = this.#sites.get(id);
        return record ? this.#info(record) : null;
    }

    list(workspaceId?: string): SiteInfo[] {
        return [...this.#sites.values()]
            .filter((s) => workspaceId === undefined || this.#workspaceOf(s) === workspaceId)
            .map((s) => this.#info(s));
    }

    /** `<name>.gen → 127.0.0.1:<port>` for every site that is up. */
    routes(): Array<{ host: string; target: string }> {
        return [...this.#sites.values()]
            .map((s) => this.#info(s))
            .filter((s) => (s.state === 'running' || s.state === 'external') && s.port !== null)
            .map((s) => ({ host: s.host, target: `127.0.0.1:${s.port}` }));
    }

    stop(id: string): boolean {
        const record = this.#sites.get(id);
        if (!record) return false;
        this.#stopProcesses(record);
        this.#changed();
        return true;
    }

    /** Stop and forget. ONE change event, not two — a listener re-rendering a config file should not do it twice. */
    remove(id: string): boolean {
        const record = this.#sites.get(id);
        if (!record) return false;
        // FORGET, not stop: a stopped supervisor entry would linger in Processes as a ghost row whose
        // Restart revives a site that no longer exists (#242).
        for (const procId of record.processIds) this.#deps.supervisor.forget(procId);
        record.stopped = true;
        this.#sites.delete(id);
        this.#changed();
        return true;
    }

    #stopProcesses(record: SiteRecord): void {
        for (const procId of record.processIds) this.#deps.supervisor.stop(procId);
        record.stopped = true;
    }

    #workspaceOf(record: SiteRecord): string {
        return record.input?.workspaceId ?? record.unservable!.workspaceId;
    }

    #info(record: SiteRecord): SiteInfo {
        let state: SiteState;
        if (record.unservable) state = 'unservable';
        else if (record.external) state = record.stopped ? 'stopped' : 'external';
        else if (record.processIds.length === 0) state = 'stopped';
        else {
            const main = this.#deps.supervisor.status(record.processIds[0]!);
            state = main ? main.state : 'stopped';
        }
        return {
            id: record.id,
            name: record.input?.name ?? record.unservable!.name,
            host: record.host,
            workspaceId: this.#workspaceOf(record),
            repoPath: record.input?.repoPath ?? record.unservable!.repoPath,
            serve: record.input?.serve ?? null,
            port: record.port,
            state,
            processIds: record.processIds,
            problem: record.problem,
        };
    }
}
