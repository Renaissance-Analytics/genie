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

const NAME_PREFIX = 'genie-ws-';

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

/** The workspace's long-lived dev container — where repo dev servers run. */
export function devContainerNameFor(workspaceId: string): string {
    return `${networkNameFor(workspaceId)}-dev`;
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
    return ['network', 'create', '--label', `${WORKSPACE_LABEL}=${workspaceId}`, name];
}

export function networkRemoveArgv(name: string): string[] {
    return ['network', 'rm', name];
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

    args.push('--label', `${WORKSPACE_LABEL}=${spec.workspaceId}`);
    for (const [key, value] of Object.entries(spec.labels ?? {})) {
        if (key === WORKSPACE_LABEL) continue; // already stamped, from the id
        args.push('--label', `${key}=${value}`);
    }

    args.push('--network', spec.network ?? networkNameFor(spec.workspaceId));
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

export function execArgv(id: string, argv: string[]): string[] {
    if (!argv.length) throw new Error('dev-server: exec needs a command');
    const args = ['exec', id, ...argv];
    assertLiteralArgv(args);
    return args;
}

export function imageInspectArgv(image: string): string[] {
    return ['image', 'inspect', image];
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

/** Containers in one workspace, or every Genie-managed container. `-a` because
 *  a STOPPED dev container is exactly what `ensure` needs to find and restart. */
export function psArgv(workspaceId?: string): string[] {
    const filter = workspaceId
        ? `label=${WORKSPACE_LABEL}=${workspaceId}`
        : `label=${WORKSPACE_LABEL}`;
    return ['ps', '-a', '--filter', filter, '--format', PS_FORMAT];
}
