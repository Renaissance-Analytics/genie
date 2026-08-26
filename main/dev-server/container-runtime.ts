/**
 * Genie DEV SERVER (Tynn #234, P1) — the container-runtime type surface.
 *
 * The beta.218 hosting runtime served a workspace's site from HOST-NATIVE
 * binaries: a fetched FrankenPHP, a fetched Postgres, a fetched Garnet. It works,
 * and it is the wrong substrate. It is PHP-first (a Python or Go dev server has
 * nowhere to run), it puts arbitrary project code on the user's machine with the
 * user's own permissions, and every stack we add is another platform-specific
 * binary to fetch and checksum on three operating systems.
 *
 * The dev server inverts that: **the sandbox boundary is the WORKSPACE, and the
 * substrate is a container.** Each workspace gets an isolated container network
 * and one long-lived dev container with the workspace directory mounted in. The
 * repos' dev servers — `npm run dev`, `uvicorn`, `cargo run`, `artisan serve` —
 * run INSIDE that, so the stack stops being Genie's problem: anything that can
 * be expressed as "an image plus a command plus a port" is servable.
 *
 * ## Why an interface rather than "shell out to docker"
 *
 * The owner's decision (2026-08-01) was **detect Docker OR Podman, and guide the
 * install when neither is there** — Genie Cloud pins Docker, but a desktop user
 * may have either or neither, and "neither" is the COMMON case on first run.
 * Everything above this file therefore talks to {@link ContainerRuntime} and
 * never to a CLI, so:
 *
 *   - the podman adapter is a different `bin` and two path quirks, not a fork;
 *   - the whole of P1 is unit-tested with a fake {@link CommandRunner}, with no
 *     container runtime installed on the machine running the tests;
 *   - "no runtime" is a *result* (see {@link RuntimeDetection}), never a throw.
 *     A missing Docker is not an exception — it is the guided-install path, and
 *     an exception thrown from a workspace-open handler is how that becomes a
 *     crash instead of a hint.
 *
 * ## Shape
 *
 * Deliberately the same shape as the beta.218 `SiteRuntime` in `../hosting`:
 * PURE decisions (`argv.ts`, `mount-path.ts`) separated from thin impure
 * execution (`cli-runtime.ts`), and every byte of process I/O behind an injected
 * seam. The reason is the same one that module's header gives, and so is the
 * payoff — the lifecycle is provable without a daemon, a network or an image.
 *
 * P1 is the runtime + the per-workspace sandbox ONLY. Sites (P2), services (P3)
 * and the UX (P4) are deliberately out of scope; nothing here knows what an
 * HTTP surface is.
 */

// --- which runtime ---------------------------------------------------------

/** The container runtimes Genie can drive. Both speak a Docker-compatible CLI. */
export type ContainerRuntimeKind = 'docker' | 'podman';

/**
 * Docker first.
 *
 * Not a quality judgement — Genie Cloud's fleet runs Docker, so preferring it on
 * the desktop means a workspace behaves the same in both places. Podman is the
 * fallback, and on Linux it is often the one that is already installed.
 */
export const PREFERRED_RUNTIMES: readonly ContainerRuntimeKind[] = ['docker', 'podman'];

/** Why no runtime is usable. The two need OPPOSITE advice, so they are distinct. */
export type RuntimeUnavailableReason = 'not-installed' | 'not-running';

/** What one candidate reported. Kept for the diagnostics pane — "docker: found,
 *  engine unreachable" is the sentence that ends a support thread. */
export interface RuntimeProbe {
    kind: ContainerRuntimeKind;
    /** The CLI is on PATH. */
    installed: boolean;
    /** The CLI answered AND its engine did. Only then is the runtime usable. */
    running: boolean;
    /** Engine version, when running. */
    version?: string;
    /**
     * What the CLI itself reports (`docker --version`), read only when the
     * ENGINE did not answer.
     *
     * The evidence that the runtime IS installed while its daemon is stopped.
     * Discarding it left every caller with nothing to show for an installed
     * Docker Desktop that happened not to be running, so the Toolchain page
     * rendered "Not installed" — and would then offer to install it again
     * (genie#212). Kept separate from {@link version} on purpose: the engine's
     * version is genuinely unknown here, and saying otherwise would be a
     * different lie.
     */
    clientVersion?: string;
    /** Redacted CLI output explaining a failed probe. */
    detail?: string;
}

export interface RuntimeDetection {
    /** `none` means nothing usable — read {@link reason} to know what to say. */
    kind: ContainerRuntimeKind | 'none';
    /** Engine version of the selected runtime. */
    version?: string;
    /** Present iff `kind === 'none'`: what the user should do about it. */
    installHint?: string;
    reason?: RuntimeUnavailableReason;
    probes: RuntimeProbe[];
}

// --- what gets run ---------------------------------------------------------

/**
 * A host directory made visible inside a container.
 *
 * `source` is always the HOST path in the host's own notation (`C:\work\acme` on
 * Windows). Translating it is the adapter's job, not the caller's — see
 * `mount-path.ts` for why the same path is two different strings depending on
 * which runtime is driving.
 */
export interface BindMount {
    source: string;
    target: string;
    readOnly?: boolean;
}

/**
 * A container port deliberately made reachable.
 *
 * `host` omitted means "let the runtime pick" — the caller then reads the real
 * port back with {@link ContainerRuntime.portMappings}. `hostIp` defaults to
 * loopback: a workspace's dev server is not put on the LAN unless someone asks.
 */
export interface PortPublish {
    container: number;
    host?: number;
    hostIp?: string;
    protocol?: 'tcp' | 'udp';
}

/**
 * A named docker/podman VOLUME made visible inside a container.
 *
 * Distinct from {@link BindMount} because the two answer different needs. A bind
 * mount is "the user's directory, visible in the sandbox". A volume is state the
 * ENGINE owns — a database cluster's data directory — which needs the
 * container's own uid/gid and filesystem semantics, and which must survive the
 * container being replaced.
 */
export interface VolumeMount {
    /** The volume name. Created on first use by the runtime. */
    name: string;
    target: string;
}

/**
 * A container HEALTHCHECK that OVERRIDES whatever the image baked in.
 *
 * The load-bearing case: the FrankenPHP production image (`dunglas/frankenphp`)
 * ships a HEALTHCHECK that curls its Caddy ADMIN endpoint on :2019 — which
 * `php-server` mode leaves disabled ("admin endpoint disabled" in the log) — so
 * the check can never pass and the container sits `(unhealthy)` forever even
 * while it serves correctly (genie #119, Blocker 5). Genie replaces it with one
 * aimed at the REAL serve port.
 *
 * `cmd` is a single shell string run via the container's `/bin/sh -c` (docker's
 * `CMD-SHELL` form). It is the ONE deliberate exception to `argv.ts`'s "no argv
 * is ever a shell string" rule, allowed only because it is Genie-constructed
 * from a validated integer port and never carries user-supplied text.
 */
export interface ContainerHealthcheck {
    cmd: string;
    intervalSec?: number;
    timeoutSec?: number;
    retries?: number;
    startPeriodSec?: number;
}

/** Everything needed to create one container. Workspace-scoped by construction,
 *  except for the machine-scoped shared service engines — see `workspaceId`. */
export interface ContainerSpec {
    /**
     * The sandbox this belongs to. Becomes the `genie.workspace` label, which is
     * what every list and every teardown filters on.
     *
     * `null` means MACHINE-scoped: a SHARED service engine (P3) serves many
     * workspaces at once, so it belongs to none of them. It must not carry a
     * workspace label, because `teardownWorkspaceSandbox` removes exactly what
     * carries one — a shared Postgres tagged with whichever workspace started it
     * would be destroyed when that workspace was removed, taking every other
     * workspace's data with it. Such a container names its `network` explicitly
     * (there is no workspace network to default to) and is found by the
     * `genie.service` label instead.
     */
    workspaceId: string | null;
    /** Container name — derived, stable, and the way an existing container is
     *  recognised on the next run (see `argv.ts#devContainerNameFor`). */
    name: string;
    image: string;
    /** Literal argv appended after the image. Never a shell string. */
    command?: string[];
    env?: Record<string, string>;
    mounts?: BindMount[];
    /** Named volumes — engine-owned state that outlives the container. */
    volumes?: VolumeMount[];
    /** ONLY these ports are reachable. An empty list is a closed container. */
    ports?: PortPublish[];
    /** Defaults to the workspace's own network — the isolation boundary. */
    network?: string;
    /**
     * Extra `host:ip` entries (`--add-host`). The sandbox sets
     * `host.docker.internal → host-gateway` so a site can reach a HOST
     * `manageProcess` service (Docker Desktop resolves that name already; Linux
     * needs the `host-gateway` add-host). Surfaced to the app as
     * `GENIE_HOST_GATEWAY` (#130).
     */
    extraHosts?: Record<string, string>;
    labels?: Record<string, string>;
    workdir?: string;
    restart?: 'no' | 'unless-stopped';
    /** e.g. `2g`. */
    memory?: string;
    /** e.g. `2`. */
    cpus?: string;
    /** Reap zombies — a dev container runs whatever the repo spawns. */
    init?: boolean;
    /**
     * Override the image's baked-in HEALTHCHECK. See {@link ContainerHealthcheck}
     * — used to replace FrankenPHP's broken :2019 admin-endpoint check with one
     * aimed at the real serve port (genie #119, Blocker 5).
     */
    healthcheck?: ContainerHealthcheck;
    /**
     * Rootless-Podman user-namespace mode. **Podman only** — the argv builder
     * DROPS it for docker.
     *
     * Rootless podman maps the invoking user to root inside the container, so a
     * bind-mounted workspace comes out owned by a subuid the host cannot write
     * to. `keep-id` maps the user to the SAME uid inside, which is the podman
     * answer to the problem `HOST_UID`/`HOST_GID` solves for docker.
     *
     * Not shared with docker because docker's `--userns` accepts only `host` or
     * empty: passing `keep-id` there is not ignored, it is a hard CLI error.
     * That asymmetry is exactly why this is a spec FIELD rather than something
     * a caller appends — see `dev-base/README.md` item 2.
     */
    userns?: 'keep-id';
}

export interface ContainerRef {
    id: string;
    name: string;
}

export type ContainerState =
    | 'running'
    | 'exited'
    | 'created'
    | 'paused'
    | 'restarting'
    | 'removing'
    | 'dead'
    | 'unknown';

export interface ContainerSummary {
    id: string;
    name: string;
    image: string;
    state: ContainerState;
    /** The CLI's human status column (`Up 3 minutes`). */
    status?: string;
    /** Set when the listing was filtered to one workspace — every row in such a
     *  listing carries that label by construction, so it is not re-parsed. */
    workspaceId?: string;
}

export interface PortMapping {
    container: number;
    protocol: 'tcp' | 'udp';
    hostIp: string;
    hostPort: number;
}

export interface NetworkRef {
    name: string;
    /** False when it already existed — this is what makes ensure idempotent. */
    created: boolean;
}

export interface LogOptions {
    tail?: number;
}

/**
 * How a command runs INSIDE a container.
 *
 * The three fields exist for one caller: the production build. A build step has
 * to run in the repo it is building, usually needs the environment the server
 * will get, and can legitimately take minutes — `cargo build --release` and
 * `composer install` both do. The adapter's default timeout is sized for
 * `docker ps`, so a build that did not pass one would be killed mid-compile and
 * report a failure that is entirely Genie's.
 */
export interface ExecOptions {
    /** The container-side working directory. */
    workdir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
}

// --- getting an image onto the machine -------------------------------------

/**
 * A long image operation's progress, and its outcome.
 *
 * `onProgress` is the whole reason pulls and builds are not just another
 * `CommandResult`: a multi-gigabyte pull that reports only on completion is
 * indistinguishable from a hang, and the caller — a first-run dialog, or an MCP
 * agent relaying to a user — needs the line as it arrives.
 */
export interface ImageProgressOptions {
    /** Raw CLI output, chunk by chunk, as the operation runs. */
    onProgress?: (chunk: string) => void;
}

/** The outcome of a pull or a build. Never a rejection — see the interface. */
export interface ImageResult {
    ok: boolean;
    /** The image that was pulled, or the tag the build produced. */
    image: string;
    /** True when nothing was fetched because the image was already local. */
    alreadyPresent?: boolean;
    /** Set when `ok` is false: the tail of what the CLI said. */
    error?: string;
}

/** What to build, and from where. `context` is a HOST path — the adapter
 *  translates it exactly as it does a bind-mount source. */
export interface ImageBuildSpec {
    /** The tag the built image gets. This is what a spec then runs. */
    tag: string;
    /** The build context directory, on the host. */
    context: string;
    /** A Dockerfile path RELATIVE to the context. Omit for `<context>/Dockerfile`. */
    dockerfile?: string;
    /** `--build-arg` pairs. */
    buildArgs?: Record<string, string>;
}

// --- the interface ---------------------------------------------------------

/**
 * "Given a workspace, give me an isolated network and containers on it; start,
 * stop, inspect and tear them down."
 *
 * Every method is workspace-scoped or id-scoped, and everything created is
 * labelled, so a workspace's footprint is always enumerable and always
 * removable — which is what makes `teardownWorkspaceSandbox` able to converge.
 */
export interface ContainerRuntime {
    readonly kind: ContainerRuntimeKind;

    /** Is this runtime actually usable right now? Never throws. */
    detect(): Promise<RuntimeDetection>;

    /** The workspace's isolated network. Idempotent. */
    networkEnsure(workspaceId: string): Promise<NetworkRef>;
    /** A network by NAME, with arbitrary labels — the shared-services network
     *  belongs to no workspace. Idempotent. */
    networkEnsureNamed(name: string, labels?: Record<string, string>): Promise<NetworkRef>;
    /** Remove it. Removing one that is already gone is success. */
    networkRemove(workspaceId: string): Promise<void>;

    /**
     * Attach a container to another network.
     *
     * How one shared engine serves many isolated workspaces: it joins each
     * consuming workspace's network on demand, so every workspace can reach it
     * while none of them can reach each other. Idempotent — attaching something
     * already attached is success.
     */
    networkConnect(network: string, containerId: string): Promise<void>;
    /** Detach. Tolerant, for the same reason `stop` is. */
    networkDisconnect(network: string, containerId: string): Promise<void>;

    /** Drop a named volume. Tolerant of one that is already gone. */
    volumeRemove(name: string): Promise<void>;

    /** Is the image already local? */
    imageExists(image: string): Promise<boolean>;

    /**
     * Fetch an image, reporting progress as it goes.
     *
     * NOT called on its own initiative anywhere: a multi-gigabyte download is
     * something the user (or an agent acting for them) agrees to first — see the
     * consent seam on `ensureWorkspaceSandbox`. This is the mechanism, not the
     * policy.
     */
    pullImage(image: string, opts?: ImageProgressOptions): Promise<ImageResult>;

    /** Build an image from a repo's own Dockerfile (the layer-1 run mode). */
    buildImage(spec: ImageBuildSpec, opts?: ImageProgressOptions): Promise<ImageResult>;

    runContainer(spec: ContainerSpec): Promise<ContainerRef>;
    start(id: string): Promise<void>;
    /** Tolerant: stopping something already gone is success. */
    stop(id: string): Promise<void>;
    /** Tolerant, for the same reason. */
    remove(id: string): Promise<void>;

    /** Run a literal argv inside a container. Returns the result verbatim —
     *  a non-zero exit is the CALLER's to interpret, not a failure here. */
    exec(id: string, argv: string[], opts?: ExecOptions): Promise<CommandResult>;

    /** A bounded log tail. */
    logs(id: string, opts?: LogOptions): Promise<string>;
    /**
     * Live logs.
     *
     * Split from {@link logs} rather than expressed as `logs(id, { follow })`
     * because the two genuinely differ in KIND: one resolves with a string, the
     * other hands back something you must be able to stop. Folding them into one
     * signature would make every caller narrow a union to find out which it got.
     */
    followLogs(id: string, onData: (chunk: string) => void): StreamHandle;

    /** Containers in one workspace, or every Genie-managed container.
     *  Returns `[]` — not a throw — when the engine is unreachable. */
    ps(workspaceId?: string): Promise<ContainerSummary[]>;

    /** Service ENGINE containers, by the `genie.service` label. Shared engines
     *  have no workspace, so {@link ps} cannot see them. Same `[]` contract. */
    psServices(engineKey?: string): Promise<ContainerSummary[]>;

    portMappings(id: string): Promise<PortMapping[]>;
}

// --- injected seams (this is what makes the adapters unit-testable) --------

export interface CommandResult {
    /** `null` when the executable could not be spawned at all. */
    code: number | null;
    stdout: string;
    stderr: string;
}

export interface RunOptions {
    cwd?: string;
    env?: Record<string, string>;
    /**
     * Stop waiting after this long. A hung `docker` must not hang Genie.
     *
     * With {@link idleGraceMs} set this is a FLOOR rather than a wall — see
     * `run-budget.ts`, which explains why a package install cannot be given an
     * honest fixed number.
     */
    timeoutMs?: number;
    /**
     * Extend {@link timeoutMs} by this much whenever the child produces output.
     *
     * For long, legitimately slow work (a package install, an archive extract)
     * where elapsed time says nothing about whether anything is happening.
     * Omitted → the timeout is a plain wall, which is right for a probe.
     */
    idleGraceMs?: number;
    /** The wall {@link idleGraceMs} can never push past, measured from the
     *  spawn. Ignored without `idleGraceMs`. */
    ceilingMs?: number;
    /** Appended to the timeout message. The place to say what the user should do
     *  about it — a bare "timed out" is a dead end. */
    timeoutNote?: string;
}

export interface StreamOptions {
    onData(chunk: string): void;
    env?: Record<string, string>;
}

/** A long-lived child (a log follow), reduced to what callers need. */
export interface StreamHandle {
    readonly pid?: number;
    /** Resolves once the child is gone. Never rejects. */
    readonly exited: Promise<number | null>;
    /** Idempotent. */
    stop(): void;
}

/**
 * The single process seam every adapter runs through.
 *
 * `run` is the one-shot form (`docker ps`, `docker run -d`) — the interesting
 * thing about those is their EXIT. `stream` is the long-lived form (`docker logs
 * -f`), where the interesting thing is the output as it arrives. Same split, and
 * the same reasons, as `ProcessSpawner`/`CommandRunner` in `../hosting/services`.
 *
 * Injected rather than imported so the adapters' tests never load
 * `node:child_process`, and so a fake can assert the exact argv Genie would have
 * typed.
 */
export interface CommandRunner {
    run(command: string, args: string[], opts?: RunOptions): Promise<CommandResult>;
    stream(command: string, args: string[], opts: StreamOptions): StreamHandle;
}
