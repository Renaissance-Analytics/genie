import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { imageFor, SERVICE_CATALOG, serviceEnvFor, switchActiveWarning, type ServiceInstance, type ServiceScope } from '../core/services.js';
import { runtimeDir } from './paths.js';
import type { ServiceDriver } from './service-driver.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * THE SERVICE REGISTRY (§6.6) — which engines each workspace holds, durable, driving the Docker driver.
 *
 * Adding an engine allocates a loopback port and credentials, needs CONSENT before an image is pulled,
 * creates and starts the container, and remembers the instance. The first version of an engine in a
 * workspace is active; a second is not until chosen, and `switchWarning` says what the switch costs
 * (data visibility) BEFORE it happens. A shared engine is one per workstation. The env a workspace
 * gets is `serviceEnvFor` over its own instances plus the shared ones. Status is read from Docker on
 * every ask — never remembered.
 *
 * Genie 1's engines are TAKEN OVER here (`adoptFromV1`, planned by core/v1-services.ts): registered
 * as they are — their container, volume, port and credentials — with no driver call at all. Nothing
 * in this file ever creates, pulls or re-keys an adopted instance: `add` answers it as `exists`, and
 * there is no path that writes a credential over one.
 *
 * `onChange` fires after every write and every start or stop, whoever asked — the person's Services tab or an agent's
 * `services` tool — so the tab redraws when an agent acts (main.ts pushes the feature snapshot on it).
 */

export interface RegistryDeps {
    readonly allocatePort: () => number;
    readonly randomPassword: () => string;
}

/** What the Genie 1 take-over did, kept IN services.json — the store it filled — so "once" and the instances cannot disagree. */
export interface V1ServicesImportRecord {
    readonly at: string;
    /** false = this boot could not read Genie 1's database: provisional, a later boot that can still takes over. */
    readonly sawV1: boolean;
    /** false = Docker did not answer: provisional, for the same reason — nothing was observed, so nothing was decided. */
    readonly sawDocker: boolean;
    readonly adopted?: number;
    /** Adopted instances whose id was already here — left exactly as they were. */
    readonly alreadyHere?: number;
    readonly started?: number;
    readonly stopped?: number;
    readonly skipped?: number;
    /** Docker calls that failed (a start or a stop): while any did, the take-over is not done and the next boot repeats it. */
    readonly failed?: number;
}

interface RegistryFile {
    instances: ServiceInstance[];
    v1Import?: V1ServicesImportRecord;
}

export type AddResult =
    | { kind: 'added'; instance: ServiceInstance }
    | { kind: 'exists'; instance: ServiceInstance }
    | { kind: 'needs-consent'; image: string; note: string };

export class ServiceRegistry {
    readonly #file: string;
    readonly #driver: ServiceDriver;
    readonly #deps: RegistryDeps;
    #data: RegistryFile;
    readonly #listeners = new Set<() => void>();

    private constructor(file: string, driver: ServiceDriver, deps: RegistryDeps, data: RegistryFile) {
        this.#file = file;
        this.#driver = driver;
        this.#deps = deps;
        this.#data = data;
    }

    static async open(userData: string, driver: ServiceDriver, deps: RegistryDeps): Promise<ServiceRegistry> {
        const file = join(runtimeDir(userData), 'services.json');
        return new ServiceRegistry(file, driver, deps, await readJson<RegistryFile>(file, { instances: [] }));
    }

    list(workspaceId?: string): ServiceInstance[] {
        return this.#data.instances.filter((i) => workspaceId === undefined || (i.scope.kind === 'dedicated' && i.scope.workspaceId === workspaceId));
    }

    /** A workspace's own engines plus the shared ones — what its processes and terminals get. */
    envFor(workspaceId: string): Record<string, string> {
        const mine = this.#data.instances.filter((i) => i.scope.kind === 'shared' || (i.scope.kind === 'dedicated' && i.scope.workspaceId === workspaceId));
        return serviceEnvFor(mine, workspaceId);
    }

    /** The Genie 1 take-over's record, or `null` before any boot has looked. */
    v1Import(): V1ServicesImportRecord | null {
        return this.#data.v1Import ?? null;
    }

    /**
     * REGISTER Genie 1's engines as they are, and record the take-over — one write, so the record and the
     * instances cannot disagree. No driver call: the containers exist and are Genie 1's; creating, pulling or
     * starting is not this method's to do. An id already here is left exactly as it is (a second pass after a
     * crash adds nothing twice). Answers how many were new.
     */
    async adoptFromV1(input: { instances: readonly ServiceInstance[]; record: V1ServicesImportRecord }): Promise<{ adopted: number; alreadyHere: number }> {
        const have = new Set(this.#data.instances.map((i) => i.id));
        const fresh = input.instances.filter((i) => i.adopted === 'v1' && !have.has(i.id));
        this.#data = { ...this.#data, instances: [...this.#data.instances, ...fresh], v1Import: input.record };
        await this.#flush();
        return { adopted: fresh.length, alreadyHere: input.instances.length - fresh.length };
    }

    async add(input: { engine: string; major: string; scope: ServiceScope; consent: boolean }): Promise<AddResult> {
        const def = SERVICE_CATALOG.find((e) => e.engine === input.engine);
        if (!def) throw new Error(`${input.engine} is not an engine Genie manages`);
        if (def.sharing === 'shared-only' && input.scope.kind !== 'shared') throw new Error(`${input.engine} is a shared service — one per workstation, never per workspace`);

        // BEFORE the adopt-only refusal: asking for the MinIO Genie 1 left is answered with it, not refused.
        const existing = this.#data.instances.find((i) => i.engine === input.engine && i.version === input.major && sameScope(i.scope, input.scope));
        if (existing) return { kind: 'exists', instance: existing };
        if (def.adoptOnly) throw new Error(`${input.engine} can only be taken over from Genie 1, not added: its images are no longer published`);

        const image = await this.#driver.ensureImage(imageFor(def, input.major), { consent: input.consent });
        if (image.kind === 'needs-consent') return { kind: 'needs-consent', image: image.image, note: image.note ?? '' };

        const publishedPort = this.#deps.allocatePort();
        const database = input.scope.kind === 'dedicated' ? input.scope.workspaceId : 'app';
        const credentials = def.engine === 'redis' || def.engine === 'reverb' ? {} : { user: 'genie', password: this.#deps.randomPassword(), database };
        const created = await this.#driver.create({ engine: input.engine, major: input.major, scope: input.scope, publishedPort, credentials });
        if (!created.ok) throw new Error(created.reason);
        await this.#driver.start(created.name);

        const siblings = this.#data.instances.filter((i) => i.engine === input.engine && sameScope(i.scope, input.scope));
        const instance: ServiceInstance = {
            id: `svc_${randomUUID()}`,
            engine: input.engine,
            version: input.major,
            scope: input.scope,
            publishedPort,
            credentials,
            active: siblings.length === 0,
        };
        this.#data.instances.push(instance);
        await this.#flush();
        return { kind: 'added', instance };
    }

    switchWarning(workspaceId: string, engine: string, to: string): string | null {
        const current = this.list(workspaceId).find((i) => i.engine === engine && i.active);
        if (!current || current.version === to) return null;
        return switchActiveWarning({ engine, from: current.version, to });
    }

    async setActive(workspaceId: string, engine: string, version: string): Promise<void> {
        this.#data.instances = this.#data.instances.map((i) => {
            if (i.engine !== engine) return i;
            // An adopted engine's "active" is the workspace's SLICE: one shared Postgres is active for one workspace and not another.
            const slice = i.adopted === 'v1' ? i.slices?.[workspaceId] : undefined;
            if (slice) return { ...i, slices: { ...i.slices, [workspaceId]: { ...slice, active: i.version === version } } };
            return i.scope.kind === 'dedicated' && i.scope.workspaceId === workspaceId ? { ...i, active: i.version === version } : i;
        });
        await this.#flush();
    }

    status(id: string): Promise<{ state: 'running'; since: string } | { state: 'exited' } | { state: 'absent' }> {
        return this.#driver.status(this.#nameOf(id));
    }

    async start(id: string): Promise<void> {
        await this.#driver.start(this.#nameOf(id));
        this.#changed();
    }

    async stop(id: string): Promise<void> {
        await this.#driver.stop(this.#nameOf(id));
        this.#changed();
    }

    /** Fires after an engine is added, adopted, made active, removed, started or stopped. Returns an unsubscribe. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        for (const l of this.#listeners) l();
    }

    async remove(id: string, options: { deleteData: boolean }): Promise<void> {
        const volume = this.#data.instances.find((x) => x.id === id)?.volume;
        await this.#driver.remove(this.#nameOf(id), { ...options, ...(volume ? { volume } : {}) });
        this.#data.instances = this.#data.instances.filter((i) => i.id !== id);
        await this.#flush();
    }

    #nameOf(id: string): string {
        const i = this.#data.instances.find((x) => x.id === id);
        if (!i) throw new Error(`no service ${id}`);
        // An adopted container keeps Genie 1's name (`genie-svc-postgres-17`): deriving one would address a container that does not exist.
        if (i.containerName) return i.containerName;
        const key = i.scope.kind === 'shared' ? 'shared' : i.scope.workspaceId;
        return `genie-${key}-${i.engine}-${i.version}`;
    }

    async #flush(): Promise<void> {
        await writeJsonAtomic(this.#file, this.#data);
        this.#changed();
    }
}

function sameScope(a: ServiceScope, b: ServiceScope): boolean {
    return a.kind === b.kind && (a.kind === 'shared' || (b.kind === 'dedicated' && a.workspaceId === b.workspaceId));
}
