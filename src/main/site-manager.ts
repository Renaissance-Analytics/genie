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

export type SiteState = 'running' | 'restarting' | 'stopped' | 'exited' | 'failed' | 'external';

export interface SiteInfo {
    readonly id: string;
    readonly name: string;
    readonly host: string;
    readonly workspaceId: string;
    readonly repoPath: string;
    readonly serve: SiteServe;
    readonly port: number;
    readonly state: SiteState;
    /** Supervisor process ids, main first. Empty for an external site. */
    readonly processIds: readonly string[];
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
    readonly input: CreateSiteInput;
    readonly id: string;
    readonly host: string;
    readonly port: number;
    readonly processIds: readonly string[];
    readonly external: boolean;
    stopped: boolean;
}

export class SiteManager {
    readonly #deps: SiteManagerDeps;
    readonly #sites = new Map<string, SiteRecord>();

    constructor(deps: SiteManagerDeps) {
        this.#deps = deps;
    }

    create(input: CreateSiteInput): SiteInfo {
        const host = genHost(input.name);
        for (const s of this.#sites.values()) {
            if (s.host === host) throw new Error(`${host} is already a site (${s.id}); two sites cannot share a name`);
        }
        const id = `site_${host.slice(0, -'.gen'.length)}`;
        const env = input.env ? { ...input.env } : undefined;
        const proc = (procId: string, name: string, command: string) =>
            this.#deps.supervisor.start({ id: procId, workspaceId: input.workspaceId, name, command, cwd: input.repoPath, restart: 'on-failure', ...(env ? { env } : {}) });

        let record: SiteRecord;
        if (input.serve.mode === 'proxy') {
            if (input.hostPort !== undefined) {
                record = { input, id, host, port: input.hostPort, processIds: [], external: true, stopped: false };
            } else if (input.devServer) {
                const port = this.#deps.allocatePort();
                proc(id, `${host} dev server`, input.devServer.command.replaceAll('{port}', String(port)));
                record = { input, id, host, port, processIds: [id], external: false, stopped: false };
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
                proc(`${id}-fcgi`, `${host} php worker`, `php-cgi -b 127.0.0.1:${fcgiPort}`);
                processIds.push(`${id}-fcgi`);
                spec = { mode: 'php', root: input.serve.root, fcgiPort };
            } else {
                spec = input.serve;
            }
            const caddyfile = serveCaddyfile({ sitePort: port, repoPath: input.repoPath, serve: spec })!;
            const configPath = join(this.#deps.configDir, id, 'Caddyfile');
            this.#deps.writeConfig(configPath, caddyfile);
            proc(id, `${host} server`, `${caddy} run --config ${configPath} --adapter caddyfile`);
            // Main process first in the list: the route's target and the state's source.
            record = { input, id, host, port, processIds: [id, ...processIds], external: false, stopped: false };
        }
        this.#sites.set(id, record);
        return this.#info(record);
    }

    get(id: string): SiteInfo | null {
        const record = this.#sites.get(id);
        return record ? this.#info(record) : null;
    }

    list(workspaceId?: string): SiteInfo[] {
        return [...this.#sites.values()]
            .filter((s) => workspaceId === undefined || s.input.workspaceId === workspaceId)
            .map((s) => this.#info(s));
    }

    /** `<name>.gen → 127.0.0.1:<port>` for every site that is up. */
    routes(): Array<{ host: string; target: string }> {
        return [...this.#sites.values()]
            .map((s) => this.#info(s))
            .filter((s) => s.state === 'running' || s.state === 'external')
            .map((s) => ({ host: s.host, target: `127.0.0.1:${s.port}` }));
    }

    stop(id: string): boolean {
        const record = this.#sites.get(id);
        if (!record) return false;
        for (const procId of record.processIds) this.#deps.supervisor.stop(procId);
        record.stopped = true;
        return true;
    }

    remove(id: string): boolean {
        if (!this.stop(id)) return false;
        this.#sites.delete(id);
        return true;
    }

    #info(record: SiteRecord): SiteInfo {
        let state: SiteState;
        if (record.external) state = record.stopped ? 'stopped' : 'external';
        else {
            const main = this.#deps.supervisor.status(record.processIds[0]!);
            state = main ? main.state : 'stopped';
        }
        return {
            id: record.id,
            name: record.input.name,
            host: record.host,
            workspaceId: record.input.workspaceId,
            repoPath: record.input.repoPath,
            serve: record.input.serve,
            port: record.port,
            state,
            processIds: record.processIds,
        };
    }
}
