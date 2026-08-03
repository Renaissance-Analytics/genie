import { createHash } from 'node:crypto';
import { toMountSource } from './mount-path';
import type { ContainerRuntimeKind, ContainerSpec, LogOptions } from './container-runtime';

/**
 * PURE. Every command line the dev server will ever type.
 *
 * Splitting the argv out of the adapters buys the same thing `caddyfile.ts`
 * bought the beta.218 hosting runtime: the decisions become directly assertable
 * with no process, no daemon and no image. And the decisions here are the ones
 * with teeth — what is labelled, what network a container joins, which ports are
 * published, and whether anything the user typed can ever become a command.
 *
 * ## The injection story
 *
 * There is no shell. `seams.ts` spawns with `shell: false`, so every token in
 * these arrays is one literal argument: a workspace path containing `&`, a repo
 * name containing `$(id)`, an env value containing `;` are all inert. That is
 * the property, and it is stronger than escaping.
 *
 * What is still checked here is the small set of things that would break the
 * ARGUMENT GRAMMAR rather than the shell: a NUL byte (which cannot be passed to
 * a process at all), a `,` or `=` inside a `--mount` value, and an environment
 * NAME that is not a variable name. Those are validated instead of trusted, so
 * threading project-supplied text into a new flag later fails loudly rather than
 * quietly becoming an argument-injection bug.
 */

// --- labels ----------------------------------------------------------------

/** Stamped on every network and container. This label IS the workspace
 *  boundary: `ps` filters on it, and teardown removes exactly what carries it. */
export const WORKSPACE_LABEL = 'genie.workspace';

/** What a container is FOR (`workspace-dev` in P1; sites and services in P2/P3). */
export const ROLE_LABEL = 'genie.role';

export const WORKSPACE_DEV_ROLE = 'workspace-dev';

/** A container serving one dev SITE (P2). */
export const SITE_ROLE = 'site';

/** Which site a `site`-role container serves — its opaque `devSiteIdFor` id.
 *  Read back on adopt, so a restarted Genie recognises what is already up. */
export const SITE_LABEL = 'genie.site';

/** A container running a backing SERVICE engine — Postgres, Redis, … (P3). */
export const SERVICE_ROLE = 'service';

/**
 * Which engine a `service`-role container IS — its `<engine>-<major>` key.
 *
 * This label, not {@link WORKSPACE_LABEL}, is how service engines are found.
 * A SHARED engine belongs to no workspace (see {@link ContainerSpec.workspaceId}),
 * so it carries only this one; a dedicated engine carries both.
 */
export const SERVICE_LABEL = 'genie.service';

/**
 * The home network of every SHARED service engine.
 *
 * A shared engine is additionally attached to each consuming workspace's own
 * network, on demand — that is how one Postgres serves twenty isolated
 * workspaces without any of them being able to see each other. It still needs a
 * network to be CREATED on (a container is always on one), and using the first
 * consumer's would make the engine's home depend on the order workspaces
 * happened to start in — and would leave it homeless when that consumer
 * released.
 */
export const SHARED_SERVICES_NETWORK = 'genie-services';

const NAME_PREFIX = 'genie-ws-';

/** Container and volume names for service engines. */
const SERVICE_NAME_PREFIX = 'genie-svc-';

// --- names -----------------------------------------------------------------

/** Longest slug we will put in a name, before the `genie-ws-`/`-dev` wrapping. */
const MAX_SLUG = 48;

/** What a container/network name may contain after the first character. */
const SAFE_NAME_CHARS = /[^a-z0-9_.-]+/g;

/**
 * A container-safe, STABLE, collision-free slug for a workspace id.
 *
 * Genie's `workspaces.id` is free-form TEXT, so it may be a uuid (already a legal
 * name) or something with spaces and slashes in it (not). Sanitising alone is
 * not enough: `Acme Corp` and `acme/corp` both reduce to `acme-corp`, and two
 * workspaces sharing one dev container would each see the other's files. So a
 * lossy sanitisation gets an 8-hex digest of the ORIGINAL id appended — the name
 * stays readable, and it stays unique.
 *
 * Deterministic, because these names are how the next run FINDS what this run
 * created.
 */
export function workspaceSlugFor(workspaceId: string): string {
    const raw = String(workspaceId ?? '');
    const lower = raw.toLowerCase();
    const sanitised = lower
        .replace(SAFE_NAME_CHARS, '-')
        .replace(/^[^a-z0-9]+/, '')
        .replace(/[^a-z0-9]+$/, '');

    if (sanitised && sanitised === lower && sanitised.length <= MAX_SLUG) return sanitised;

    const digest = createHash('sha1').update(raw).digest('hex').slice(0, 8);
    const stem = sanitised.slice(0, MAX_SLUG - 9).replace(/[^a-z0-9]+$/, '') || 'workspace';
    return `${stem}-${digest}`;
}

/** The workspace's isolated network. */
export function networkNameFor(workspaceId: string): string {
    return `${NAME_PREFIX}${workspaceSlugFor(workspaceId)}`;
}

/** The workspace's long-lived dev container — the toolchain/shell home. */
export function devContainerNameFor(workspaceId: string): string {
    return `${networkNameFor(workspaceId)}-dev`;
}

/**
 * The container serving one dev site.
 *
 * A site gets its OWN container rather than an `exec` into the workspace dev
 * container, for one hard reason: a published port is fixed when a container is
 * CREATED. There is no way to add one to a container that is already running, so
 * a dev server exec'd into the long-lived sandbox could never be reached from
 * the host no matter what it bound. The site container joins the same network,
 * mounts the same workspace and carries the same labels — it is inside the
 * sandbox in every sense that matters — and in exchange `start`, `stop`,
 * `restart` and `logs` map one-to-one onto container verbs instead of onto
 * process bookkeeping we would have to invent.
 *
 * Derived, not stored: the next run finds what this one made even after a reboot
 * or a database that has forgotten.
 */
export function siteContainerNameFor(workspaceId: string, siteName: string): string {
    return `${networkNameFor(workspaceId)}-site-${workspaceSlugFor(siteName)}`;
}

/**
 * The container running one service ENGINE.
 *
 * Keyed by `<engine>-<major>` (`postgres-16`) and NOT by workspace, because that
 * is the owner's service model in one line: a user with twenty PG16 workspaces
 * runs ONE postgres. Two workspaces asking for Postgres 16 derive the same name,
 * so the second one adopts the first one's container instead of starting a
 * second copy — the same "derived, not stored" identity trick the dev container
 * and the site container use, doing the deduplication for free.
 *
 * `workspaceId` is passed ONLY for an opt-in DEDICATED engine, which is a
 * different container serving one workspace and must not collide with the shared
 * one.
 */
export function serviceContainerNameFor(engineKey: string, workspaceId?: string): string {
    const base = `${SERVICE_NAME_PREFIX}${workspaceSlugFor(engineKey)}`;
    return workspaceId ? `${base}-${workspaceSlugFor(workspaceId)}` : base;
}

/**
 * The named volume holding one engine's state.
 *
 * A named volume rather than a bind mount: a database's data directory needs
 * the container's own uid/gid and filesystem semantics, and bind-mounting one
 * out to a Windows or macOS host is the classic way to get a corrupt cluster.
 * It also survives `remove` — replacing an engine container (a version bump, a
 * changed flag) must not drop every workspace's data.
 */
export function serviceVolumeNameFor(
    engineKey: string,
    suffix: string,
    workspaceId?: string,
): string {
    return `${serviceContainerNameFor(engineKey, workspaceId)}-${workspaceSlugFor(suffix)}`;
}

// --- guards ----------------------------------------------------------------

/** Environment names we will put on a command line. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A NUL cannot be passed to a process at all — Node throws deep inside `spawn`
 * with a message that names neither the flag nor the value. Catching it here
 * means the error says which container spec was wrong.
 */
function assertLiteralArgv(args: string[]): void {
    for (const token of args) {
        if (token.includes('\0')) {
            throw new Error('dev-server: refusing an argument containing a NUL byte');
        }
    }
}

// --- detection -------------------------------------------------------------

/** Asks the ENGINE, not the CLI — a stopped Docker Desktop fails this. */
export function serverVersionArgv(): string[] {
    return ['version', '--format', '{{.Server.Version}}'];
}

/** Asks only the CLI, which is how "installed but not running" is told apart
 *  from "not installed". */
export function clientVersionArgv(): string[] {
    return ['--version'];
}

// --- networks --------------------------------------------------------------

export function networkLsArgv(name: string): string[] {
    return ['network', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'];
}

export function networkCreateArgv(name: string, workspaceId: string): string[] {
    return networkCreateNamedArgv(name, { [WORKSPACE_LABEL]: workspaceId });
}

/** Create a network by NAME with arbitrary labels — the shared-services network
 *  belongs to no workspace, so it cannot carry a workspace label. */
export function networkCreateNamedArgv(name: string, labels: Record<string, string>): string[] {
    const args = ['network', 'create'];
    for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
    args.push(name);
    assertLiteralArgv(args);
    return args;
}

export function networkRemoveArgv(name: string): string[] {
    return ['network', 'rm', name];
}

/**
 * Attach a RUNNING container to another network.
 *
 * The mechanism the shared-service model rests on: a container may be on many
 * networks at once, so one Postgres can be reachable from each consuming
 * workspace's isolated network while those workspaces still cannot see each
 * other — the engine is the only node they have in common, and it enforces the
 * rest with per-workspace databases and roles.
 */
export function networkConnectArgv(network: string, containerId: string): string[] {
    return ['network', 'connect', network, containerId];
}

/** The other half of the reference count: detach when a workspace releases. */
export function networkDisconnectArgv(network: string, containerId: string): string[] {
    return ['network', 'disconnect', network, containerId];
}

/** Drop one engine's data volume (only ever on an explicit `remove`). */
export function volumeRemoveArgv(name: string): string[] {
    return ['volume', 'rm', name];
}

// --- containers ------------------------------------------------------------

export interface ArgvOptions {
    kind: ContainerRuntimeKind;
    platform: NodeJS.Platform | string;
}

/**
 * `docker run` / `podman run` for one spec.
 *
 * Detached, named, labelled, and on the workspace's own network — those four are
 * not options, because each one is load-bearing for a property the sandbox
 * promises: detached so the container outlives the call, named so the next run
 * recognises it, labelled so teardown can find it, and networked so it cannot
 * see another workspace's containers.
 *
 * Note what is NOT here and never will be: `--network host` and `--privileged`.
 * Either dissolves the boundary this whole module exists to draw.
 */
export function runArgv(spec: ContainerSpec, opts: ArgvOptions): string[] {
    const args = ['run', '-d', '--name', spec.name];

    // A null workspace is MACHINE-scoped infrastructure (a shared service
    // engine), and it must not carry a workspace label: `teardownWorkspaceSandbox`
    // sweeps exactly what carries one, so a shared Postgres labelled with the
    // first workspace that happened to use it would be destroyed when that
    // workspace was removed — taking every other workspace's data with it.
    if (spec.workspaceId !== null) {
        args.push('--label', `${WORKSPACE_LABEL}=${spec.workspaceId}`);
    }
    for (const [key, value] of Object.entries(spec.labels ?? {})) {
        if (key === WORKSPACE_LABEL) continue; // already stamped, from the id
        args.push('--label', `${key}=${value}`);
    }

    const network =
        spec.network ?? (spec.workspaceId === null ? null : networkNameFor(spec.workspaceId));
    if (!network) {
        throw new Error('dev-server: a container with no workspace must name its network');
    }
    args.push('--network', network);
    // Podman ONLY. Docker's `--userns` takes `host` or empty, so `keep-id`
    // there is a hard CLI error rather than a no-op — the flag has to be
    // dropped here, where the runtime kind is known, and not by every caller.
    if (spec.userns === 'keep-id' && opts.kind === 'podman') args.push('--userns=keep-id');
    if (spec.restart) args.push('--restart', spec.restart);
    if (spec.workdir) args.push('--workdir', spec.workdir);
    if (spec.init) args.push('--init');
    if (spec.memory) args.push('--memory', spec.memory);
    if (spec.cpus) args.push('--cpus', spec.cpus);

    for (const mount of spec.mounts ?? []) {
        const source = toMountSource(mount.source, { platform: opts.platform, kind: opts.kind });
        if (!source) {
            throw new Error(
                `dev-server: ${mount.source} cannot be used as a bind mount — ` +
                    'it must be a local absolute path with no comma or equals sign ' +
                    '(a network share cannot be mounted into a container).',
            );
        }
        if (/[,=]/.test(mount.target)) {
            throw new Error(`dev-server: invalid mount target ${mount.target}`);
        }
        const readOnly = mount.readOnly ? ',readonly' : '';
        args.push('--mount', `type=bind,source=${source},target=${mount.target}${readOnly}`);
    }

    for (const volume of spec.volumes ?? []) {
        // Same grammar check as a bind mount, and for the same reason: a `,` or
        // `=` inside either half silently becomes another `--mount` OPTION
        // rather than part of the value.
        if (/[,=]/.test(volume.name) || /[,=]/.test(volume.target)) {
            throw new Error(
                `dev-server: invalid volume mount ${volume.name} -> ${volume.target} ` +
                    '(neither may contain a comma or an equals sign)',
            );
        }
        args.push('--mount', `type=volume,source=${volume.name},target=${volume.target}`);
    }

    for (const port of spec.ports ?? []) {
        const protocol = port.protocol ?? 'tcp';
        // Loopback by default: publishing a workspace's dev server onto the LAN
        // is a decision someone has to make, not one that happens by omission.
        const hostIp = port.hostIp ?? '127.0.0.1';
        args.push('--publish', `${hostIp}:${port.host ?? ''}:${port.container}/${protocol}`);
    }

    for (const [name, value] of Object.entries(spec.env ?? {})) {
        if (!ENV_NAME.test(name)) {
            throw new Error(`dev-server: refusing env name ${JSON.stringify(name)}`);
        }
        args.push('--env', `${name}=${value}`);
    }

    // Image last, command after it — everything before the image is a flag, and
    // anything after it belongs to the container, not to the CLI.
    args.push(spec.image, ...(spec.command ?? []));
    assertLiteralArgv(args);
    return args;
}

export function startArgv(id: string): string[] {
    return ['start', id];
}

export function stopArgv(id: string): string[] {
    return ['stop', id];
}

/** Forced, because teardown has to converge — a running container is still one
 *  the workspace no longer owns. */
export function removeArgv(id: string): string[] {
    return ['rm', '-f', id];
}

/**
 * Run a literal argv inside a container.
 *
 * `workdir` and `env` are what let the PRODUCTION BUILD run here at all. A build
 * step has to execute in the repo it is building (`composer install` in the
 * wrong directory succeeds and installs nothing) and often needs the same
 * environment the server will get (a build that reads `DATABASE_URL`). Both
 * flags are spelled identically by docker and podman.
 */
export function execArgv(
    id: string,
    argv: string[],
    opts: { workdir?: string; env?: Record<string, string> } = {},
): string[] {
    if (!argv.length) throw new Error('dev-server: exec needs a command');
    const args = ['exec'];
    if (opts.workdir) args.push('--workdir', opts.workdir);
    for (const [name, value] of Object.entries(opts.env ?? {})) {
        if (!ENV_NAME.test(name)) {
            throw new Error(`dev-server: refusing env name ${JSON.stringify(name)}`);
        }
        args.push('--env', `${name}=${value}`);
    }
    // Id last before the command, command after it — everything before the id is
    // a flag, and anything after it belongs to the container.
    args.push(id, ...argv);
    assertLiteralArgv(args);
    return args;
}

export function imageInspectArgv(image: string): string[] {
    return ['image', 'inspect', image];
}

/** Fetch one image. Streamed, not run — a pull can take minutes. */
export function pullArgv(image: string): string[] {
    const args = ['pull', image];
    assertLiteralArgv(args);
    return args;
}

/**
 * Build a repo's own Dockerfile into a tagged image (the layer-1 run mode).
 *
 * `dockerfile` is deliberately relative to the context and passed as `--file`
 * BEFORE the context, which is the only ordering both CLIs accept. The context
 * is a host path the caller has already translated (`toMountSource`), for the
 * same reason a bind-mount source is.
 */
export function buildArgv(spec: {
    tag: string;
    context: string;
    dockerfile?: string;
    buildArgs?: Record<string, string>;
}): string[] {
    const args = ['build', '--tag', spec.tag];
    if (spec.dockerfile) args.push('--file', spec.dockerfile);
    for (const [name, value] of Object.entries(spec.buildArgs ?? {})) {
        if (!ENV_NAME.test(name)) {
            throw new Error(`dev-server: refusing build-arg name ${JSON.stringify(name)}`);
        }
        args.push('--build-arg', `${name}=${value}`);
    }
    args.push(spec.context);
    assertLiteralArgv(args);
    return args;
}

/** Keep a log read bounded — it exists to explain something, not to dump. */
export const DEFAULT_LOG_TAIL = 500;

export function logsArgv(id: string, opts: LogOptions & { follow?: boolean } = {}): string[] {
    const args = ['logs'];
    if (opts.follow) args.push('--follow');
    args.push('--tail', String(opts.tail ?? DEFAULT_LOG_TAIL), id);
    return args;
}

export function portArgv(id: string): string[] {
    return ['port', id];
}

/**
 * Tab-delimited fields rather than `{{json .}}`.
 *
 * Docker and Podman both accept this template, but their JSON shapes DIFFER
 * (podman renders `Names` as a list, docker as a string), so a JSON parse would
 * need a per-runtime branch for no gain. Five known fields separated by a
 * character that cannot occur in any of them parses identically on both.
 */
export const PS_FORMAT = '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}';

/**
 * Every listing passes `--no-trunc`, and it is load-bearing.
 *
 * `docker ps` truncates `{{.ID}}` to 12 characters while `docker run` prints
 * all 64. Genie mixes the two constantly — one call CREATES a container and a
 * later one ADOPTS it — so without this the same container has two different
 * ids depending on which call handed it over. That stays invisible until two
 * workspaces share one service engine and the second one's `containerId` fails
 * to match the first's, which reads as "the deduplication did not work".
 *
 * Found by the live smoke, not by a unit test: a fake `ps` returns whatever
 * ids it was given, so the two forms were identical everywhere except against
 * a real daemon.
 */

/** Containers in one workspace, or every Genie-managed container. `-a` because
 *  a STOPPED dev container is exactly what `ensure` needs to find and restart. */
export function psArgv(workspaceId?: string): string[] {
    const filter = workspaceId
        ? `label=${WORKSPACE_LABEL}=${workspaceId}`
        : `label=${WORKSPACE_LABEL}`;
    return ['ps', '-a', '--no-trunc', '--filter', filter, '--format', PS_FORMAT];
}

/**
 * Service ENGINES, by the service label rather than the workspace one.
 *
 * A shared engine has no workspace, so {@link psArgv} — whose whole job is to
 * enumerate one workspace's footprint — cannot see it. This is the parallel
 * listing that can, and it is what makes a shared engine still enumerable,
 * adoptable after a restart, and removable.
 */
export function psServicesArgv(engineKey?: string): string[] {
    const filter = engineKey ? `label=${SERVICE_LABEL}=${engineKey}` : `label=${SERVICE_LABEL}`;
    return ['ps', '-a', '--no-trunc', '--filter', filter, '--format', PS_FORMAT];
}
