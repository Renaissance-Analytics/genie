import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { provisionSteps, readinessProbe, SLICED_ENGINES, stepSucceeded, type ProvisionStep } from '../core/service-provision.js';
import { deleteDataVerdict } from '../core/service-tenancy.js';
import { chooseEngines, containerNameOf, CUSTOM_KINDS, dataVolumeOf, engineKindOf, imageFor, SERVICE_CATALOG, serviceEnvFor, SHARED_TENANCY, sliceIsDroppable, switchActiveWarning, variantExtensions, type AdoptedSlice, type Credentials, type CustomEngineSpec, type EngineAdmin, type EngineChoice, type ServiceInstance, type ServiceScope } from '../core/services.js';
import { renderSockudoConfig, websocketAppOf } from '../core/websockets.js';
import { workspaceDnsName, workspaceSqlIdentifier } from '../core/v1-services.js';
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
 * A shared WEBSOCKETS engine (Sockudo, hosting ship line H8) is carved the same way with nothing run inside it: a
 * workspace's slice is an APP — `ws_<slug>` as id and key, a generated secret — in the engine's config file, which
 * Genie writes whole (core/websockets.ts) beside services.json and the container reads read-only. A change to the apps
 * rewrites the file and restarts a running engine (Genie 1 restarted its server the same way). Its slices are the one
 * kind that IS dropped (`releaseSlice`): an app holds no data, and dropping it revokes the secret.
 *
 * Deleting an engine's DATA (hosting ship line H6) is refused while any workspace other than the one asking keeps data
 * in its volume, naming them (core/service-tenancy.ts): the check runs before the first Docker call, so a refusal
 * removes nothing at all. A Mailpit is created with its web inbox published too, a Meilisearch with its master key, a
 * shared SeaweedFS with its admin identity and a bucket per workspace, and a custom image exactly as the person named it.
 * A WebSocket engine has no volume at all (stateless): there is no data to delete, and a workspace leaving it is
 * `releaseSlice`, never a delete.
 *
 * `onChange` fires after every write and every start or stop, whoever asked — the person's Services tab or an agent's
 * `services` tool — so the tab redraws when an agent acts (main.ts pushes the feature snapshot on it).
 *
 * WHICH ENGINE OF A KIND A WORKSPACE USES is `chooseEngines` (core/services.ts): its own engine before a shared one, an
 * active one before an inactive one. `use` makes one engine THE workspace's of its kind — by id, never by version (a
 * dedicated 17 and a shared 17 are two engines) — and `detach` stops a shared engine handing the workspace its env,
 * keeping its slice and data (`use` on it attaches again).
 *
 * PORTS SURVIVE A REMOVE: the loopback port(s) an engine had are remembered under its container name when it is removed
 * (`ports` in services.json, reserved like a live engine's — `reservedPorts`), and an engine added again under the same
 * name gets them back if nothing else holds them. The allocator's scan already gave the same records the same ports across
 * restarts (core/port-allocator.ts, H1); this carries that across remove + re-add, which leaves no record to scan.
 */

export interface RegistryDeps {
    readonly allocatePort: () => number;
    /** base64url — the closed alphabet a password must be in to be put on a SQL or redis-cli command line. */
    readonly randomPassword: () => string;
    /** How long a just-started engine is waited for before a slice is made in it, and how often it is asked. */
    readonly sliceReadiness?: { readonly timeoutMs: number; readonly pollMs: number };
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    /** Where an engine's config file is read and written (Sockudo's apps). Defaults to the disk. */
    readonly files?: ConfigFiles;
    /** Is a remembered port still free on 127.0.0.1? Absent = trusted (the record reserved it for this name). */
    readonly portFree?: (port: number) => Promise<boolean>;
}

/** The ports an engine had, kept under its container name after it was removed. */
export interface RememberedPorts {
    readonly port: number;
    readonly surfaces?: Readonly<Record<string, number>>;
}

export interface ConfigFiles {
    /** The file's text, or `null` when there is none. */
    readText(path: string): Promise<string | null>;
    /** Replace it whole (temp + rename). */
    writeText(path: string, text: string): Promise<void>;
    remove(path: string): Promise<void>;
}

/**
 * The disk. Mode 0644 on purpose: the engine's container runs as its own unprivileged user, which must read the file
 * through the bind mount; the folder it lives in is Genie's runtime folder, beside services.json, which holds the same
 * secrets.
 */
export const diskConfigFiles: ConfigFiles = {
    readText: (path) => readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; }),
    writeText: async (path, text) => {
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, text, { encoding: 'utf8', mode: 0o644 });
        await rename(tmp, path);
    },
    remove: (path) => rm(path, { force: true }),
};

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
    /** By container name: the ports a removed engine had, handed back when one of that name is added again. */
    ports?: Record<string, RememberedPorts>;
    /**
     * By container name: the credentials a removed engine's KEPT data holds (its own, a shared one's superuser and its
     * workspaces' slices) — an engine added again under that name is created with them, since the data sets a password
     * only when it is first made. Forgotten when the data is deleted, and once handed back.
     */
    kept?: Record<string, KeptCredentials>;
}

/** What a kept data volume was made with: what the engine must be created with again to open it. */
export interface KeptCredentials {
    readonly credentials: Credentials;
    readonly admin?: EngineAdmin;
    readonly slices?: Readonly<Record<string, AdoptedSlice>>;
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
    readonly #startedListeners = new Set<(id: string) => void>();
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
        // The namespace engines' tag and prefix are the workspace's derived name — the same `ws_<slug>` its slices use.
        return serviceEnvFor(this.#visibleTo(workspaceId), workspaceId, { namespace: workspaceSqlIdentifier(workspaceId) });
    }

    /** Per kind: the engines this workspace could use and the one it does — what `envFor` emits from (core/services.ts `chooseEngines`). */
    choices(workspaceId: string): EngineChoice[] {
        return chooseEngines(this.#visibleTo(workspaceId), workspaceId);
    }

    #visibleTo(workspaceId: string): ServiceInstance[] {
        return this.#data.instances.filter((i) => i.scope.kind === 'shared' || (i.scope.kind === 'dedicated' && i.scope.workspaceId === workspaceId));
    }

    /** Every port an engine holds or a removed engine is remembered by — what the loopback allocator must never hand out. */
    reservedPorts(): number[] {
        const live = this.#data.instances.flatMap((i) => [i.publishedPort, ...Object.values(i.publishedPorts ?? {})]);
        const kept = Object.values(this.#data.ports ?? {}).flatMap((p) => [p.port, ...Object.values(p.surfaces ?? {})]);
        return [...live, ...kept];
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
     *
     * `custom` = a custom image (validated by core/forms.ts before it gets here): `major` is the name the person gave
     * it, and the image, port and env are theirs — and its `kind`, when it declared one.
     *
     * `variant` = the engine from its variant's image (postgres → `pgvector`); a separate engine from the stock one of the
     * same major, with its own container and volume.
     */
    async add(input: { engine: string; major: string; scope: ServiceScope; consent: boolean; workspaceId?: string; custom?: CustomEngineSpec; variant?: string }): Promise<AddResult> {
        // ONE ADD PER ENGINE AT A TIME (hosting fixes 3.1): two at once both passed the "already there" check below and made
        // one container with two records. The second now runs after the first, and finds it.
        const key = JSON.stringify([input.engine, input.major, input.variant ?? null, input.scope.kind, input.scope.kind === 'dedicated' ? input.scope.workspaceId : null]);
        const ahead = this.#adding.get(key) ?? Promise.resolve();
        const mine = ahead.catch(() => {}).then(() => this.#add(input));
        this.#adding.set(key, mine);
        try {
            return await mine;
        } finally {
            if (this.#adding.get(key) === mine) this.#adding.delete(key);
        }
    }

    readonly #adding = new Map<string, Promise<AddResult>>();

    async #add(input: { engine: string; major: string; scope: ServiceScope; consent: boolean; workspaceId?: string; custom?: CustomEngineSpec; variant?: string }): Promise<AddResult> {
        const def = SERVICE_CATALOG.find((e) => e.engine === input.engine);
        if (!def) throw new Error(`${input.engine} is not an engine Genie manages`);
        if (def.sharing === 'shared-only' && input.scope.kind !== 'shared') throw new Error(`${input.engine} is a shared service — one per workstation, never per workspace`);
        if (def.sharing === 'dedicated-only' && input.scope.kind !== 'dedicated') throw new Error(`${input.engine} is always dedicated to one workspace — ${def.dedicatedBecause ?? 'an arbitrary image has no multi-tenant story to share'}`);
        if (def.custom && !input.custom) throw new Error(`${input.engine} needs its image, port and env`);
        if (input.variant !== undefined && !def.variants?.[input.variant]) throw new Error(`${input.engine} has no variant ${JSON.stringify(input.variant)}`);
        if (input.custom?.kind !== undefined && !CUSTOM_KINDS.includes(input.custom.kind)) throw new Error(`a custom image cannot be a ${JSON.stringify(input.custom.kind)} (${CUSTOM_KINDS.join(', ')})`);

        // BEFORE the adopt-only refusal: asking for the MinIO Genie 1 left is answered with it, not refused.
        const existing = this.#data.instances.find((i) => i.engine === input.engine && i.version === input.major && (i.variant ?? null) === (input.variant ?? null) && sameScope(i.scope, input.scope));
        if (existing) return { kind: 'exists', instance: input.workspaceId !== undefined ? await this.#useSlice(existing.id, input.workspaceId) : existing };
        if (def.adoptOnly) throw new Error(`${input.engine} can only be taken over from Genie 1, not added: its images are no longer published`);

        const image = await this.#driver.ensureImage(input.custom ? input.custom.image : imageFor(def, input.major, input.variant), { consent: input.consent });
        if (image.kind === 'needs-consent') return { kind: 'needs-consent', image: image.image, note: image.note ?? '' };

        // The ports this name had before it was removed, if nothing else holds them now; else new ones.
        const name = containerNameOf({ scope: input.scope, engine: input.engine, version: input.major, ...(input.variant ? { variant: input.variant } : {}) });
        const remembered = await this.#rememberedPorts(name, def.surfaces?.map((s) => s.name) ?? []);
        const publishedPort = remembered?.port ?? this.#deps.allocatePort();
        // Each surface beside the primary gets its own loopback port — Mailpit's web inbox.
        const surfacePorts: Record<string, number> = {};
        for (const surface of def.surfaces ?? []) surfacePorts[surface.name] = remembered?.surfaces?.[surface.name] ?? this.#deps.allocatePort();
        const database = input.scope.kind === 'dedicated' ? input.scope.workspaceId : 'app';
        // A shared Postgres/MySQL/MariaDB/Redis/SeaweedFS holds only its superuser; every workspace's credential is a slice.
        const tenancy = input.scope.kind === 'shared' && SLICED_ENGINES.has(def.engine) ? SHARED_TENANCY[def.engine] : undefined;
        // Its data was KEPT when it was removed: the credentials that data holds, whatever became of its port (moic,
        // 2026-10-16 — a new random password could not open the kept volume: "password authentication failed").
        const kept = def.custom ? undefined : this.#data.kept?.[name];
        const admin: EngineAdmin | undefined = tenancy ? (kept?.admin ?? { user: tenancy.adminUser, password: this.#deps.randomPassword() }) : undefined;
        const credentials: Credentials = kept && !admin ? { ...kept.credentials } : admin || def.config || def.custom
            ? {}
            // Redis's `--requirepass`; Meilisearch's master key (its only credential — namespace isolation, as Genie 1's).
            : def.engine === 'redis' || def.engine === 'meilisearch'
                ? { password: this.#deps.randomPassword() }
                : { user: 'genie', password: this.#deps.randomPassword(), database };
        // An engine that reads its workspaces from a file (Sockudo's apps): the file exists, with the asking workspace's
        // app already in it, BEFORE the container does — so it starts once, serving that app.
        let appSlices: Record<string, AdoptedSlice> | undefined;
        let configFile: string | undefined;
        if (def.config) {
            appSlices = input.workspaceId !== undefined ? { [input.workspaceId]: this.#newSlice(input.workspaceId, input.engine, {}) } : {};
            configFile = this.#configPath(name);
            await this.#files.writeText(configFile, renderSockudoConfig({ port: def.internalPort, apps: Object.values(appSlices).map(websocketAppOf) }));
        }
        const created = await this.#driver.create({
            engine: input.engine, major: input.major, scope: input.scope, publishedPort, credentials,
            ...(admin ? { admin } : {}),
            ...(def.surfaces ? { surfacePorts } : {}),
            ...(input.custom ? { custom: input.custom } : {}),
            ...(configFile ? { configFile } : {}),
            ...(input.variant ? { variant: input.variant } : {}),
        });
        if (!created.ok) throw new Error(created.reason);
        await this.#driver.start(created.name);

        // The first engine of its KIND in this scope is active: a custom image that is a Postgres counts as one.
        const kind = engineKindOf({ engine: input.engine, ...(input.custom?.kind !== undefined ? { kind: input.custom.kind } : {}) });
        const siblings = this.#data.instances.filter((i) => engineKindOf(i) === kind && sameScope(i.scope, input.scope));
        const instance: ServiceInstance = {
            id: `svc_${randomUUID()}`,
            engine: input.engine,
            version: input.major,
            scope: input.scope,
            publishedPort,
            credentials,
            active: siblings.length === 0,
            ...(input.variant ? { variant: input.variant } : {}),
            // A kept shared engine's slices are roles in that same data: back with it, never made a second time.
            ...(admin ? { admin, slices: kept?.slices ? { ...kept.slices } : {} } : {}),
            ...(appSlices ? { slices: appSlices } : {}),
            ...(def.surfaces ? { publishedPorts: surfacePorts } : {}),
            ...(input.custom ? { image: input.custom.image, internalPort: input.custom.internalPort, env: { ...input.custom.env }, ...(input.custom.kind !== undefined ? { kind: input.custom.kind } : {}) } : {}),
        };
        this.#data.instances.push(instance);
        // Handed back: no longer remembered (the instance itself now records them).
        if (this.#data.ports?.[name]) this.#data = { ...this.#data, ports: Object.fromEntries(Object.entries(this.#data.ports).filter(([k]) => k !== name)) };
        if (this.#data.kept?.[name]) this.#data = { ...this.#data, kept: Object.fromEntries(Object.entries(this.#data.kept).filter(([k]) => k !== name)) };
        await this.#flush();
        // Created and started: it is started, like a start of one already there.
        for (const l of this.#startedListeners) l(instance.id);
        if (admin && input.workspaceId !== undefined) return { kind: 'added', instance: await this.#useSlice(instance.id, input.workspaceId) };
        return { kind: 'added', instance };
    }

    /**
     * The ports remembered for this container name, if they can be handed back: none held by a live engine, each still
     * free on 127.0.0.1 (`portFree`). Otherwise the memory is dropped — it no longer describes a port this name can have —
     * and the caller allocates afresh.
     */
    async #rememberedPorts(name: string, surfaceNames: readonly string[]): Promise<RememberedPorts | null> {
        const r = this.#data.ports?.[name];
        if (!r) return null;
        const held = new Set(this.#data.instances.flatMap((i) => [i.publishedPort, ...Object.values(i.publishedPorts ?? {})]));
        const wanted = [r.port, ...surfaceNames.flatMap((s) => (r.surfaces?.[s] !== undefined ? [r.surfaces[s]!] : []))];
        let usable = true;
        for (const port of wanted) {
            if (held.has(port) || (this.#deps.portFree && !(await this.#deps.portFree(port).catch(() => false)))) { usable = false; break; }
        }
        if (usable) return r;
        this.#data = { ...this.#data, ports: Object.fromEntries(Object.entries(this.#data.ports ?? {}).filter(([k]) => k !== name)) };
        return null;
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
            if (i.slices === undefined || i.scope.kind !== 'shared' || i.slices[workspaceId]) return i;
            const app = sliceIsDroppable(i.engine);
            if (!app && (!i.admin || !SLICED_ENGINES.has(i.engine))) return i;
            const slice = this.#newSlice(workspaceId, i.engine, i.slices, `${i.engine} ${i.version}`);
            // A WebSocket app is a line in the engine's config; a database slice is made inside the engine.
            if (app) await this.#applyApps({ ...i, slices: { ...i.slices, [workspaceId]: slice } });
            else await this.#provision(i, [slice]);
            const updated: ServiceInstance = { ...this.#find(id), slices: { ...this.#find(id).slices, [workspaceId]: slice } };
            this.#data = { ...this.#data, instances: this.#data.instances.map((x) => (x.id === id ? updated : x)) };
            await this.#flush();
            return updated;
        });
        this.#slicing = run.catch(() => undefined);
        return run;
    }

    /**
     * A workspace's slice, not yet made: `ws_<slug>`, a generated password (a WebSocket app's secret), Redis's prefix,
     * SeaweedFS's bucket, and active when it is the workspace's first of the engine. Refuses a name another workspace
     * already holds.
     */
    #newSlice(workspaceId: string, engine: string, slices: Readonly<Record<string, AdoptedSlice>>, what: string = engine): AdoptedSlice {
        const identifier = workspaceSqlIdentifier(workspaceId);
        const holder = Object.entries(slices).find(([, s]) => s.identifier === identifier);
        if (holder) throw new Error(`${what}: workspace ${holder[0]} already holds the ${sliceIsDroppable(engine) ? 'app' : 'database'} named ${identifier}, which workspace ${workspaceId} would also be named; nothing was created`);
        return {
            identifier,
            password: this.#deps.randomPassword(),
            ...(engine === 'redis' ? { prefix: `${identifier}:` } : {}),
            // SeaweedFS: the bucket, which is also the access key — a DNS label (`ws-<slug>`), as Genie 1's.
            ...(engine === 'seaweedfs' ? { bucket: workspaceDnsName(workspaceId) } : {}),
            // The first version of an engine a workspace uses is its active one, as for a dedicated engine.
            ...(this.#hasActive(workspaceId, engine) ? {} : { active: true }),
        };
    }

    /**
     * Drop a workspace's slice — only where that loses nothing: a WebSocket app (its config entry, and so its secret,
     * are gone; a running engine is restarted on the new list). A database or Redis slice holds the workspace's data and
     * is never dropped here. No slice for the workspace: nothing is done.
     */
    releaseSlice(id: string, workspaceId: string): Promise<ServiceInstance> {
        const run = this.#slicing.then(async () => {
            const i = this.#find(id);
            if (!sliceIsDroppable(i.engine)) throw new Error(`${i.engine} ${i.version}: a workspace's slice holds its data, and Genie does not drop it; nothing was done`);
            if (!i.slices?.[workspaceId]) return i;
            const rest = Object.fromEntries(Object.entries(i.slices).filter(([ws]) => ws !== workspaceId));
            const updated: ServiceInstance = { ...i, slices: rest };
            await this.#applyApps(updated);
            this.#data = { ...this.#data, instances: this.#data.instances.map((x) => (x.id === id ? updated : x)) };
            await this.#flush();
            return updated;
        });
        this.#slicing = run.catch(() => undefined);
        return run;
    }

    get #files(): ConfigFiles {
        return this.#deps.files ?? diskConfigFiles;
    }

    /** An engine's config file: beside services.json, named for its container. */
    #configPath(containerName: string): string {
        return join(dirname(this.#file), 'engine-config', `${containerName}.toml`);
    }

    /**
     * Make the engine's config file say exactly `i`'s apps. Unchanged: nothing is written or restarted. Changed: the file
     * is rewritten whole and a RUNNING engine is restarted to read it (a stopped one reads it when it next starts). The
     * restart drops every workspace's open sockets for a moment and their clients reconnect — Genie 1's behaviour
     * (host-websocket.ts `restart`).
     */
    async #applyApps(i: ServiceInstance, options: { restart: boolean } = { restart: true }): Promise<void> {
        const def = SERVICE_CATALOG.find((e) => e.engine === i.engine);
        if (!def?.config) return;
        const name = this.#nameOf(i.id);
        const path = this.#configPath(name);
        const text = renderSockudoConfig({ port: def.internalPort, apps: Object.values(i.slices ?? {}).map(websocketAppOf) });
        if ((await this.#files.readText(path)) === text) return;
        await this.#files.writeText(path, text);
        if (!options.restart || (await this.#driver.status(name)).state !== 'running') return;
        await this.#driver.stop(name);
        await this.#driver.start(name);
    }

    /**
     * Put a NEW shared Redis's ACL users back — they live in the engine's memory and are gone after any restart of
     * it (Docker's `unless-stopped` restarts it on a reboot without asking Genie). Waits for the engine first. A
     * no-op for every other engine (a database and role are in the data volume) and for an adopted one (Genie 1
     * declared its users on the container's own command).
     */
    async restoreSlices(id: string): Promise<void> {
        const i = this.#find(id);
        // A WebSocket engine found running: its config says what the registry says (rewritten and restarted only if not).
        if (sliceIsDroppable(i.engine)) return this.#applyApps(i);
        if (i.engine !== 'redis' || i.adopted || !i.admin || i.slices === undefined) return;
        const slices = Object.values(i.slices);
        if (slices.length > 0) await this.#provision(i, slices);
    }

    /** Does this workspace already have an active instance of this engine (its own, or its slice of a shared one)? */
    #hasActive(workspaceId: string, engine: string): boolean {
        return this.#data.instances.some((x) => engineKindOf(x) === engine
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
            // A pgvector engine's `vector`, created as the superuser in the workspace's database: its role cannot (core/service-provision.ts).
            for (const step of provisionSteps(i.engine, admin, slice, { extensions: variantExtensions(i.engine, i.variant) })) await this.#step(name, what, slice.identifier, step);
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

    /**
     * By engine and version, as the Services tab's "Make active" has always asked: the workspace's OWN engine of that
     * version if it has one, else the shared one — never both (they are two engines; `use` takes one). None: says so.
     */
    async setActive(workspaceId: string, engine: string, version: string): Promise<void> {
        const matches = this.#visibleTo(workspaceId).filter((i) => engineKindOf(i) === engine && i.version === version);
        const target = matches.find((i) => i.scope.kind === 'dedicated') ?? matches[0];
        if (!target) throw new Error(`this workspace has no ${engine} ${version} to use; nothing was changed`);
        await this.use(workspaceId, target.id);
    }

    /**
     * Make `id` THE engine of its kind this workspace uses (core/services.ts `chooseEngines`): its own engines of the kind
     * and its slices of shared ones become inactive, this one active — and attached again if the workspace had detached
     * from it. A shared multi-tenant engine it has no slice of is USED by this: the slice is made first. Answers what
     * the workspace now uses for that kind.
     */
    async use(workspaceId: string, id: string): Promise<EngineChoice> {
        const target = this.#find(id);
        const label = `${target.engine}${target.variant ? ` (${target.variant})` : ''} ${target.version}`;
        if (target.scope.kind === 'dedicated' && target.scope.workspaceId !== workspaceId) throw new Error(`${label} is another workspace's engine; nothing was changed`);
        if (target.engine === 'custom' && target.kind === undefined) throw new Error(`the custom image ${target.version} has not said which engine it is, so it is not a choice for one; it always gives its own GENIE_SERVICE_* names. Add it again with a kind (postgres, mysql…); nothing was changed`);
        if (target.scope.kind === 'shared' && target.slices === undefined && !target.active) throw new Error(`${label} is shared with one connection for every workspace and is not its engine's active version; it cannot be chosen for one workspace. Nothing was changed`);
        if (target.scope.kind === 'shared' && target.slices !== undefined && !target.slices[workspaceId]) await this.#useSlice(id, workspaceId);
        const kind = engineKindOf(target);
        this.#data = {
            ...this.#data,
            instances: this.#data.instances.map((i) => {
                if (engineKindOf(i) !== kind) return i;
                const chosen = i.id === id;
                let next: ServiceInstance = i;
                const slice = i.slices?.[workspaceId];
                // A multi-tenant engine's "active" is the workspace's SLICE: one shared Postgres is active for one workspace and not another.
                if (slice) next = { ...next, slices: { ...next.slices, [workspaceId]: { ...slice, active: chosen } } };
                else if (i.scope.kind === 'dedicated' && i.scope.workspaceId === workspaceId) next = { ...next, active: chosen };
                // An unsliced shared engine's flag is every workspace's: when another SHARED one is chosen, this workspace stops using it by detaching.
                else if (!chosen && i.scope.kind === 'shared' && target.scope.kind === 'shared') next = withDetached(next, workspaceId, true);
                if (chosen && i.scope.kind === 'shared') next = withDetached(next, workspaceId, false);
                return next;
            }),
        };
        await this.#flush();
        return this.#choiceOf(workspaceId, kind);
    }

    /**
     * Stop a SHARED engine handing this workspace its env — Genie 1's taken-over Postgres included. Its slice, its role and
     * its data stay exactly where they are (`use` attaches again); only the connection is no longer given. The workspace
     * then uses its own engine of the kind if it has one, else none. A workspace's own engine is stopped or removed, not
     * detached.
     */
    async detach(workspaceId: string, id: string): Promise<EngineChoice> {
        const target = this.#find(id);
        if (target.scope.kind !== 'shared') throw new Error(`${target.engine} ${target.version} is this workspace's own engine: stop or remove it to stop using it; nothing was changed`);
        const slice = target.slices?.[workspaceId];
        const updated: ServiceInstance = withDetached(slice ? { ...target, slices: { ...target.slices, [workspaceId]: { ...slice, active: false } } } : target, workspaceId, true);
        this.#data = { ...this.#data, instances: this.#data.instances.map((x) => (x.id === id ? updated : x)) };
        await this.#flush();
        return this.#choiceOf(workspaceId, engineKindOf(target));
    }

    #choiceOf(workspaceId: string, kind: string): EngineChoice {
        return this.choices(workspaceId).find((c) => c.kind === kind) ?? { kind, chosen: null, candidates: [] };
    }

    status(id: string): Promise<{ state: 'running'; since: string } | { state: 'exited' } | { state: 'absent' }> {
        return this.#driver.status(this.#nameOf(id));
    }

    /** Started, and a new shared Redis's workspace users put back (they do not survive a restart of the engine). */
    async start(id: string): Promise<void> {
        // A WebSocket engine's config first, so it starts on the registry's apps (written only if it differs; no restart).
        if (sliceIsDroppable(this.#find(id).engine)) await this.#applyApps(this.#find(id), { restart: false });
        await this.#driver.start(this.#nameOf(id));
        this.#changed();
        await this.restoreSlices(id);
        for (const l of this.#startedListeners) l(id);
    }

    async stop(id: string): Promise<void> {
        await this.#driver.stop(this.#nameOf(id));
        this.#changed();
    }

    /** Update the recorded engine in place. Its registry identity, env and the person's stopped state stay intact. */
    async update(id: string, options: { consent: boolean; beforeStop?: () => void }) {
        const i = this.#find(id);
        try {
            const result = await this.#driver.update(this.#nameOf(id), { ...options, afterStart: () => this.restoreSlices(id) });
            if (result.kind === 'updated') this.#changed();
            return result;
        } catch (error) {
            // An adopted image may read a secret file: its env is not every credential this engine holds.
            const secrets = [i.credentials.password, i.admin?.password, ...Object.values(i.slices ?? {}).map((s) => s.password), ...Object.values(i.env ?? {})]
                .filter((s): s is string => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
            throw new Error(secrets.reduce((text, secret) => text.split(secret).join('********'), (error as Error).message));
        }
    }

    /** Fires with an engine's id each time it is started — added, or started again (Tynn #766 C2b: its sound). */
    onStarted(listener: (id: string) => void): () => void {
        this.#startedListeners.add(listener);
        return () => { this.#startedListeners.delete(listener); };
    }

    /** Fires after an engine is added, adopted, made active, removed, started or stopped. Returns an unsubscribe. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        for (const l of this.#listeners) l();
    }

    /**
     * Removed, keeping its data volume — unless `deleteData`, which `workspaceId` (who is asking) may do only when no
     * OTHER workspace keeps data in it (core/service-tenancy.ts). A refusal throws, naming them, before any Docker call:
     * the container is not removed either, so a refused delete leaves everything exactly as it was.
     */
    async remove(id: string, options: { deleteData: boolean; workspaceId?: string }): Promise<void> {
        const i = this.#find(id);
        if (options.deleteData) {
            const verdict = deleteDataVerdict(i, options.workspaceId);
            if (!verdict.allowed) throw new Error(verdict.reason);
        }
        const name = this.#nameOf(id);
        await this.#driver.remove(name, { deleteData: options.deleteData, volume: dataVolumeOf(i) });
        // The apps' secrets go with the engine: nothing is left on disk that could sign for an app no engine serves.
        if (SERVICE_CATALOG.find((e) => e.engine === i.engine)?.config) await this.#files.remove(this.#configPath(name));
        this.#data.instances = this.#data.instances.filter((x) => x.id !== id);
        // Its ports, kept under its container name: added again by that name, it gets them back (an adopted one is Genie 1's
        // container, never re-added under its name, so nothing is kept for it).
        if (!i.adopted) {
            this.#data = { ...this.#data, ports: { ...(this.#data.ports ?? {}), [name]: { port: i.publishedPort, ...(i.publishedPorts && Object.keys(i.publishedPorts).length > 0 ? { surfaces: { ...i.publishedPorts } } : {}) } } };
        }
        // Its credentials, kept with its data (and only while that data is): an engine added again by this name must be
        // made with what the data holds. A custom image's are its own env, given again by whoever adds it.
        const keeps = !options.deleteData && !i.adopted && i.engine !== 'custom' && dataVolumeOf(i) !== null;
        const others = Object.fromEntries(Object.entries(this.#data.kept ?? {}).filter(([k]) => k !== name));
        this.#data = {
            ...this.#data,
            kept: keeps
                ? { ...others, [name]: { credentials: { ...i.credentials }, ...(i.admin ? { admin: i.admin } : {}), ...(i.slices && i.admin ? { slices: { ...i.slices } } : {}) } }
                : others,
        };
        await this.#flush();
    }

    /** The end of the engine's own output (`docker logs`, bounded — service-driver.ts `logTail`). */
    logs(id: string, tail?: number): Promise<{ text: string; tail: number }> {
        return this.#driver.logs(this.#nameOf(id), tail);
    }

    #find(id: string): ServiceInstance {
        const i = this.#data.instances.find((x) => x.id === id);
        if (!i) throw new Error(`no service ${id}`);
        return i;
    }

    /** An adopted container keeps Genie 1's name (`genie-svc-postgres-17`): deriving one would address a container that does not exist. */
    #nameOf(id: string): string {
        return containerNameOf(this.#find(id));
    }

    async #flush(): Promise<void> {
        await writeJsonAtomic(this.#file, this.#data);
        this.#changed();
    }
}

/** The instance with `workspaceId` added to (or taken off) its `detached` list; the field is dropped when it empties. */
function withDetached(i: ServiceInstance, workspaceId: string, detached: boolean): ServiceInstance {
    const rest = (i.detached ?? []).filter((w) => w !== workspaceId);
    const list = detached ? [...rest, workspaceId] : rest;
    const { detached: _old, ...base } = i;
    return list.length > 0 ? { ...base, detached: list } : base;
}

function sameScope(a: ServiceScope, b: ServiceScope): boolean {
    return a.kind === b.kind && (a.kind === 'shared' || (b.kind === 'dedicated' && a.workspaceId === b.workspaceId));
}
