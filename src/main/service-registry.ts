import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SERVICE_CATALOG, serviceEnvFor, switchActiveWarning, type ServiceInstance, type ServiceScope } from '../core/services.js';
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
 */

export interface RegistryDeps {
    readonly allocatePort: () => number;
    readonly randomPassword: () => string;
}

interface RegistryFile {
    instances: ServiceInstance[];
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
        return serviceEnvFor(mine);
    }

    async add(input: { engine: string; major: string; scope: ServiceScope; consent: boolean }): Promise<AddResult> {
        const def = SERVICE_CATALOG.find((e) => e.engine === input.engine);
        if (!def) throw new Error(`${input.engine} is not an engine Genie manages`);
        if (def.sharing === 'shared-only' && input.scope.kind !== 'shared') throw new Error(`${input.engine} is a shared service — one per workstation, never per workspace`);

        const existing = this.#data.instances.find((i) => i.engine === input.engine && i.version === input.major && sameScope(i.scope, input.scope));
        if (existing) return { kind: 'exists', instance: existing };

        const image = await this.#driver.ensureImage(`${def.image}:${input.major}`, { consent: input.consent });
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
        this.#data.instances = this.#data.instances.map((i) =>
            i.engine === engine && i.scope.kind === 'dedicated' && i.scope.workspaceId === workspaceId ? { ...i, active: i.version === version } : i,
        );
        await this.#flush();
    }

    status(id: string): Promise<{ state: 'running'; since: string } | { state: 'exited' } | { state: 'absent' }> {
        return this.#driver.status(this.#nameOf(id));
    }

    async start(id: string): Promise<void> {
        await this.#driver.start(this.#nameOf(id));
    }

    async stop(id: string): Promise<void> {
        await this.#driver.stop(this.#nameOf(id));
    }

    async remove(id: string, options: { deleteData: boolean }): Promise<void> {
        await this.#driver.remove(this.#nameOf(id), options);
        this.#data.instances = this.#data.instances.filter((i) => i.id !== id);
        await this.#flush();
    }

    #nameOf(id: string): string {
        const i = this.#data.instances.find((x) => x.id === id);
        if (!i) throw new Error(`no service ${id}`);
        const key = i.scope.kind === 'shared' ? 'shared' : i.scope.workspaceId;
        return `genie-${key}-${i.engine}-${i.version}`;
    }

    async #flush(): Promise<void> {
        await writeJsonAtomic(this.#file, this.#data);
    }
}

function sameScope(a: ServiceScope, b: ServiceScope): boolean {
    return a.kind === b.kind && (a.kind === 'shared' || (b.kind === 'dedicated' && a.workspaceId === b.workspaceId));
}
