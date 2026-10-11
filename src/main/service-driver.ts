import { containerPlan, SERVICE_CATALOG, type Credentials, type ServiceScope } from '../core/services.js';

/**
 * SERVICE ENGINES — the Docker driver (§6.6).
 *
 * Every effect is a `docker` invocation through an injected runner (execFile in production, a fake
 * in tests). Pulls happen only with CONSENT — an image is a download the person should know about.
 * A container is created from `containerPlan` (loopback-only publishing, engine-keyed name and
 * volume). Status is READ from `docker inspect` on every ask, never remembered. Removing a container
 * keeps its data volume unless asked: switching versions never destroys data.
 */

export type DockerRunner = (args: readonly string[]) => Promise<{ stdout: string; exitCode: number }>;

const DATA_DIRS: Record<string, string> = {
    postgres: '/var/lib/postgresql/data',
    mysql: '/var/lib/mysql',
    mariadb: '/var/lib/mysql',
    redis: '/data',
    mongo: '/data/db',
    reverb: '/data',
};

export class ServiceDriver {
    readonly #run: DockerRunner;

    constructor(run: DockerRunner) {
        this.#run = run;
    }

    async available(): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
        try {
            const r = await this.#run(['version', '--format', '{{.Server.Version}}']);
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
        if (!options.consent) return { kind: 'needs-consent', image, note: `${image} is not on this machine; pulling it downloads the image from Docker Hub.` };
        const pulled = await this.#run(['pull', image]);
        if (pulled.exitCode !== 0) throw new Error(pulled.stdout.trim() || `docker pull ${image} failed`);
        return { kind: 'pulled', image };
    }

    async create(input: { engine: string; major: string; scope: ServiceScope; publishedPort: number; credentials?: Credentials }): Promise<{ ok: true; name: string; existed?: true } | { ok: false; reason: string }> {
        const plan = containerPlan(input);
        const existing = await this.#run(['container', 'inspect', plan.name]);
        if (existing.exitCode === 0) return { ok: true, name: plan.name, existed: true };
        const def = SERVICE_CATALOG.find((e) => e.engine === input.engine)!;
        const dataDir = DATA_DIRS[def.engine] ?? '/data';
        const args = ['create', '--name', plan.name, '-p', plan.publish, '-v', `${plan.volume}:${dataDir}`, '--restart', 'unless-stopped'];
        for (const [k, v] of Object.entries(plan.env)) args.push('-e', `${k}=${v}`);
        args.push(plan.image);
        const r = await this.#run(args);
        if (r.exitCode !== 0) return { ok: false, reason: r.stdout.trim() || `docker create ${plan.name} failed (exit ${r.exitCode})` };
        return { ok: true, name: plan.name };
    }

    async start(name: string): Promise<void> {
        const r = await this.#run(['start', name]);
        if (r.exitCode !== 0) throw new Error(r.stdout.trim() || `docker start ${name} failed`);
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

    async remove(name: string, options: { deleteData: boolean }): Promise<void> {
        await this.#run(['rm', '-f', name]);
        if (options.deleteData) await this.#run(['volume', 'rm', `${name}-data`]);
    }
}
