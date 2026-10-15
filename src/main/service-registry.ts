import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { provisionSteps, readinessProbe, SLICED_ENGINES, stepSucceeded, type ProvisionStep } from '../core/service-provision.js';
import { imageFor, SERVICE_CATALOG, serviceEnvFor, SHARED_TENANCY, switchActiveWarning, type AdoptedSlice, type Credentials, type EngineAdmin, type ServiceInstance, type ServiceScope } from '../core/services.js';
import { workspaceSqlIdentifier } from '../core/v1-services.js';
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
 * A SHARED Postgres / MySQL / MariaDB / Redis is MULTI-TENANT (hosting ship line H3), as Genie 1's were: created
 * with only its own superuser (`admin`, generated once), and each workspace that USES it — adds it, or makes it its
 * active version — gets its own slice first: a database + role (Redis: an ACL user pinned to a key prefix) named
 * `ws_<slug>` with its own password, made through the engine's own client in its container
 * (core/service-provision.ts). Made once per workspace; asking again makes nothing. Nothing here drops a slice: a
 * workspace that stops using an engine keeps its data in it. A Redis slice lives in memory only, so it is put back
 * every time the engine is started (`start`) or found running at Genie start (`restoreSlices`).
 *
 * `onChange` fires after every write and every start or stop, whoever asked — the person's Services tab or an agent's
 * `services` tool — so the tab redraws when an agent acts (main.ts pushes the feature snapshot on it).
 */

export interface RegistryDeps {
    readonly allocatePort: () => number;
    /** base64url — the closed alphabet a password must be in to be put on a SQL or redis-cli command line. */
    readonly randomPassword: () => string;
    /** How long a just-started engine is waited for before a slice is made in it, and how often it is asked. */
    readonly sliceReadiness?: { readonly timeoutMs: number; readonly pollMs: number };
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_SLICE_READINESS = { timeoutMs: 60_000, pollMs: 500 } as const;

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
    /** Slices are made one at a time: two at once for one workspace would race two passwords onto one role. */
    #slicing: Promise<unknown> = Promise.resolve();

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

    /**
     * `workspaceId` is the workspace that will USE the engine: for a shared multi-tenant one, its slice is made (once)
     * before the answer — on a new engine and on one that already exists alike.
     */
    async add(input: { engine: string; major: string; scope: ServiceScope; consent: boolean; workspaceId?: string }): Promise<AddResult> {
        const def = SERVICE_CATALOG.find((e) => e.engine === input.engine);
        if (!def) throw new Error(`${input.engine} is not an engine Genie manages`);
        if (def.sharing === 'shared-only' && input.scope.kind !== 'shared') throw new Error(`${input.engine} is a shared service — one per workstation, never per workspace`);

        // BEFORE the adopt-only refusal: asking for the MinIO Genie 1 left is answered with it, not refused.
        const existing = this.#data.instances.find((i) => i.engine === input.engine && i.version === input.major && sameScope(i.scope, input.scope));
        if (existing) return { kind: 'exists', instance: input.workspaceId !== undefined ? await this.#useSlice(existing.id, input.workspaceId) : existing };
        if (def.adoptOnly) throw new Error(`${input.engine} can only be taken over from Genie 1, not added: its images are no longer published`);

        const image = await this.#driver.ensureImage(imageFor(def, input.major), { consent: input.consent });
        if (image.kind === 'needs-consent') return { kind: 'needs-consent', image: image.image, note: image.note ?? '' };

        const publishedPort = this.#deps.allocatePort();
        const database = input.scope.kind === 'dedicated' ? input.scope.workspaceId : 'app';
        // A shared Postgres/MySQL/MariaDB/Redis holds only its superuser; every workspace's credential is a slice.
        const tenancy = input.scope.kind === 'shared' && SLICED_ENGINES.has(def.engine) ? SHARED_TENANCY[def.engine] : undefined;
        const admin: EngineAdmin | undefined = tenancy ? { user: tenancy.adminUser, password: this.#deps.randomPassword() } : undefined;
        const credentials: Credentials = admin || def.engine === 'reverb'
            ? {}
            : def.engine === 'redis'
                ? { password: this.#deps.randomPassword() }
                : { user: 'genie', password: this.#deps.randomPassword(), database };
        const created = await this.#driver.create({ engine: input.engine, major: input.major, scope: input.scope, publishedPort, credentials, ...(admin ? { admin } : {}) });
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
            ...(admin ? { admin, slices: {} } : {}),
        };
        this.#data.instances.push(instance);
        await this.#flush();
        if (admin && input.workspaceId !== undefined) return { kind: 'added', instance: await this.#useSlice(instance.id, input.workspaceId) };
        return { kind: 'added', instance };
    }

    /**
     * The workspace's slice of a multi-tenant engine, made if it has none: a database + role (or ACL user) through the
     * engine's own client, then recorded. An existing slice is answered as it is — nothing is re-run or re-keyed (an
     * adopted one is Genie 1's). Throws, with the engine's own words, when the engine does not come up or a step fails;
     * nothing is recorded then, so asking again retries.
     */
    #useSlice(id: string, workspaceId: string): Promise<ServiceInstance> {
        const run = this.#slicing.then(async () => {
            const i = this.#find(id);
            if (i.slices === undefined || !i.admin || !SLICED_ENGINES.has(i.engine) || i.scope.kind !== 'shared') return i;
            if (i.slices[workspaceId]) return i;
            const identifier = workspaceSqlIdentifier(workspaceId);
            const holder = Object.entries(i.slices).find(([, s]) => s.identifier === identifier);
            if (holder) throw new Error(`${i.engine} ${i.version}: workspace ${holder[0]} already holds the database named ${identifier}, which workspace ${workspaceId} would also be named; nothing was created`);
            const slice: AdoptedSlice = {
                identifier,
                password: this.#deps.randomPassword(),
                ...(i.engine === 'redis' ? { prefix: `${identifier}:` } : {}),
                // The first version of an engine a workspace uses is its active one, as for a dedicated engine.
                ...(this.#hasActive(workspaceId, i.engine) ? {} : { active: true }),
            };
            await this.#provision(i, [slice]);
            const updated: ServiceInstance = { ...this.#find(id), slices: { ...this.#find(id).slices, [workspaceId]: slice } };
            this.#data = { ...this.#data, instances: this.#data.instances.map((x) => (x.id === id ? updated : x)) };
            await this.#flush();
            return updated;
        });
        this.#slicing = run.catch(() => undefined);
        return run;
    }

    /**
     * Put a NEW shared Redis's ACL users back — they live in the engine's memory and are gone after any restart of
     * it (Docker's `unless-stopped` restarts it on a reboot without asking Genie). Waits for the engine first. A
     * no-op for every other engine (a database and role are in the data volume) and for an adopted one (Genie 1
     * declared its users on the container's own command).
     */
    async restoreSlices(id: string): Promise<void> {
        const i = this.#find(id);
        if (i.engine !== 'redis' || i.adopted || !i.admin || i.slices === undefined) return;
        const slices = Object.values(i.slices);
        if (slices.length > 0) await this.#provision(i, slices);
    }

    /** Does this workspace already have an active instance of this engine (its own, or its slice of a shared one)? */
    #hasActive(workspaceId: string, engine: string): boolean {
        return this.#data.instances.some((x) => x.engine === engine
            && (x.slices !== undefined ? x.slices[workspaceId]?.active === true : x.scope.kind === 'dedicated' && x.scope.workspaceId === workspaceId && x.active));
    }

    /** The engine answers its own client (bounded), then every slice's steps run in order; the first that fails throws. */
    async #provision(i: ServiceInstance, slices: readonly AdoptedSlice[]): Promise<void> {
        const name = this.#nameOf(i.id);
        const admin = i.admin!;
        const what = `${i.engine} ${i.version}`;
        const bound = this.#deps.sliceReadiness ?? DEFAULT_SLICE_READINESS;
        const now = this.#deps.now ?? Date.now;
        const sleep = this.#deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const probe = readinessProbe(i.engine, admin);
        const deadline = now() + bound.timeoutMs;
        for (;;) {
            const r = await this.#driver.exec(name, probe.argv);
            if (stepSucceeded(probe, r)) break;
            if (now() >= deadline) throw new Error(`${what} did not answer within ${Math.round(bound.timeoutMs / 1000)} s (${r.stdout.trim() || `exit ${r.exitCode}`}); no workspace database was created — ask again once it is running`);
            await sleep(bound.pollMs);
        }
        for (const slice of slices) {
            for (const step of provisionSteps(i.engine, admin, slice)) await this.#step(name, what, slice.identifier, step);
        }
    }

    async #step(name: string, what: string, identifier: string, step: ProvisionStep): Promise<void> {
        const r = await this.#driver.exec(name, step.argv);
        if (!stepSucceeded(step, r)) throw new Error(`${what}: making the ${step.label} for ${identifier} failed: ${r.stdout.trim() || `exit ${r.exitCode}`}`);
    }

    switchWarning(workspaceId: string, engine: string, to: string): string | null {
        const current = this.list(workspaceId).find((i) => i.engine === engine && i.active);
        if (!current || current.version === to) return null;
        return switchActiveWarning({ engine, from: current.version, to });
    }

    async setActive(workspaceId: string, engine: string, version: string): Promise<void> {
        // Choosing a shared multi-tenant engine this workspace has no slice of IS using it: the slice is made first.
        const unsliced = this.#data.instances.find((i) => i.engine === engine && i.version === version && i.scope.kind === 'shared' && i.slices !== undefined && !i.slices[workspaceId]);
        if (unsliced) await this.#useSlice(unsliced.id, workspaceId);
        this.#data.instances = this.#data.instances.map((i) => {
            if (i.engine !== engine) return i;
            // A multi-tenant engine's "active" is the workspace's SLICE: one shared Postgres is active for one workspace and not another.
            const slice = i.slices?.[workspaceId];
            if (slice) return { ...i, slices: { ...i.slices, [workspaceId]: { ...slice, active: i.version === version } } };
            return i.scope.kind === 'dedicated' && i.scope.workspaceId === workspaceId ? { ...i, active: i.version === version } : i;
        });
        await this.#flush();
    }

    status(id: string): Promise<{ state: 'running'; since: string } | { state: 'exited' } | { state: 'absent' }> {
        return this.#driver.status(this.#nameOf(id));
    }

    /** Started, and a new shared Redis's workspace users put back (they do not survive a restart of the engine). */
    async start(id: string): Promise<void> {
        await this.#driver.start(this.#nameOf(id));
        this.#changed();
        await this.restoreSlices(id);
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

    #find(id: string): ServiceInstance {
        const i = this.#data.instances.find((x) => x.id === id);
        if (!i) throw new Error(`no service ${id}`);
        return i;
    }

    #nameOf(id: string): string {
        const i = this.#find(id);
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
