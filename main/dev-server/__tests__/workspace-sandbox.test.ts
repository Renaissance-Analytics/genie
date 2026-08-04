import { describe, expect, it } from 'vitest';
import { GENIE_DEV_BASE_IMAGE, WORKSPACE_MOUNT_TARGET } from '../images';
import { ensureWorkspaceSandbox, teardownWorkspaceSandbox } from '../workspace-sandbox';
import { WORKSPACE_LABEL } from '../argv';
import { CADDY_HTTPS_PORT } from '../caddyfile';
import type {
    ContainerRuntime,
    ContainerSpec,
    ContainerSummary,
    RuntimeDetection,
} from '../container-runtime';

/**
 * The workspace SANDBOX — the whole of P1's behaviour, above the runtime.
 *
 * Two properties carry the feature:
 *
 *   - **Idempotence.** `ensureWorkspaceSandbox` is called on every workspace
 *     open, so the second call must find what the first one made rather than
 *     stack a second dev container onto the same workspace directory.
 *   - **A missing runtime is a RESULT.** Most desktops have no container
 *     runtime the first time this runs. That is the guided-install path, and it
 *     must reach the caller as a status with a hint — never as a throw through
 *     the IPC boundary.
 */

// --- a fake ContainerRuntime -----------------------------------------------

interface Fake extends ContainerRuntime {
    readonly containers: Map<string, ContainerSummary>;
    readonly networks: Set<string>;
    readonly ran: ContainerSpec[];
    readonly started: string[];
    readonly removed: string[];
    readonly removedNetworks: string[];
    /** Images `pullImage` was asked for, in order. */
    readonly pulled: string[];
}

interface FakeOptions {
    detection?: RuntimeDetection;
    imagePresent?: boolean;
    existing?: ContainerSummary[];
    existingNetworks?: string[];
    /** Blow up on this verb, to prove the sandbox converts throws to statuses. */
    throwOn?: 'networkEnsure' | 'runContainer' | 'ps';
    kind?: 'docker' | 'podman';
    /** What a pull does. Default: succeeds and makes the image present. */
    pullFails?: string;
    /** Simulate a PRE-REWORK sandbox: it publishes no Caddy port, so an adopt
     *  must recreate it. Default false (a proper sandbox reports the port). */
    caddyPortless?: boolean;
}

const DOCKER_OK: RuntimeDetection = { kind: 'docker', version: '27.3.1', probes: [] };

function fakeRuntime(opts: FakeOptions = {}): Fake {
    const containers = new Map<string, ContainerSummary>(
        (opts.existing ?? []).map((c) => [c.name, c]),
    );
    const networks = new Set<string>(opts.existingNetworks ?? []);
    const ran: ContainerSpec[] = [];
    const started: string[] = [];
    const removed: string[] = [];
    const removedNetworks: string[] = [];
    const pulled: string[] = [];
    let imagePresent = opts.imagePresent ?? true;
    const boom = (verb: FakeOptions['throwOn']) => {
        if (opts.throwOn === verb) throw new Error(`fake: ${verb} exploded`);
    };

    return {
        kind: opts.kind ?? 'docker',
        containers,
        networks,
        ran,
        started,
        removed,
        removedNetworks,
        pulled,

        async detect() {
            return opts.detection ?? DOCKER_OK;
        },
        async networkEnsure(workspaceId) {
            boom('networkEnsure');
            const name = `genie-ws-${workspaceId}`;
            const created = !networks.has(name);
            networks.add(name);
            return { name, created };
        },
        async networkRemove(workspaceId) {
            const name = `genie-ws-${workspaceId}`;
            removedNetworks.push(name);
            networks.delete(name);
        },
        async networkEnsureNamed(name) {
            const created = !networks.has(name);
            networks.add(name);
            return { name, created };
        },
        async networkConnect() {},
        async networkDisconnect() {},
        async volumeRemove() {},
        async imageExists() {
            return imagePresent;
        },
        async pullImage(image) {
            pulled.push(image);
            if (opts.pullFails) return { ok: false, image, error: opts.pullFails };
            imagePresent = true;
            return { ok: true, image };
        },
        async buildImage(spec) {
            return { ok: true, image: spec.tag };
        },
        async runContainer(spec) {
            boom('runContainer');
            ran.push(spec);
            containers.set(spec.name, {
                id: `id-${spec.name}`,
                name: spec.name,
                image: spec.image,
                state: 'running',
                ...(spec.workspaceId === null ? {} : { workspaceId: spec.workspaceId }),
            });
            return { id: `id-${spec.name}`, name: spec.name };
        },
        async start(id) {
            started.push(id);
            for (const c of containers.values()) if (c.id === id) c.state = 'running';
        },
        async stop(id) {
            for (const c of containers.values()) if (c.id === id) c.state = 'exited';
        },
        async remove(id) {
            removed.push(id);
            for (const [name, c] of containers) if (c.id === id) containers.delete(name);
        },
        async exec() {
            return { code: 0, stdout: '', stderr: '' };
        },
        async logs() {
            return '';
        },
        followLogs() {
            return { stop() {}, exited: Promise.resolve(0) };
        },
        async psServices() {
            return [];
        },
        async ps(workspaceId) {
            boom('ps');
            return [...containers.values()].filter(
                (c) => !workspaceId || c.workspaceId === workspaceId,
            );
        },
        async portMappings() {
            // A proper (post-rework) sandbox publishes the Caddy https port; a
            // pre-rework one publishes nothing, forcing an adopt to recreate it.
            // Shape MUST match what the real runtime emits (`PortMapping.hostPort`,
            // cli-runtime.ts#parsePorts) — an earlier fake used `host:` and hid a
            // bug where `readCaddyHostPort` read the wrong field.
            return opts.caddyPortless
                ? []
                : [{ container: CADDY_HTTPS_PORT, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 51820 }];
        },
    };
}

const WS_PATH = '/repos/acme';

// --- ensure -----------------------------------------------------------------

describe('ensureWorkspaceSandbox', () => {
    it('creates an isolated network and a dev container with the workspace mounted', async () => {
        const runtime = fakeRuntime();

        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
        });

        expect(result).toMatchObject({
            ok: true,
            network: 'genie-ws-acme',
            container: { name: 'genie-ws-acme-dev' },
            created: { network: true, container: true },
        });
        const spec = runtime.ran[0];
        expect(spec?.image).toBe(GENIE_DEV_BASE_IMAGE);
        expect(spec?.network).toBe('genie-ws-acme');
        expect(spec?.labels?.[WORKSPACE_LABEL]).toBe('acme');
        expect(spec?.mounts).toEqual([{ source: WS_PATH, target: WORKSPACE_MOUNT_TARGET }]);
        expect(spec?.workdir).toBe(WORKSPACE_MOUNT_TARGET);
    });

    it('publishes ONE loopback https port for the workspace Caddy — the single .gen door', async () => {
        const runtime = fakeRuntime();
        const result = await ensureWorkspaceSandbox('acme', WS_PATH, { runtime, platform: 'linux' });
        expect(runtime.ran[0]?.ports).toEqual([{ container: CADDY_HTTPS_PORT, hostIp: '127.0.0.1' }]);
        // The published host port is read back and surfaced for the router.
        expect(result).toMatchObject({ ok: true, caddyHostPort: 51820 });
    });

    it('recreates a PRE-REWORK sandbox that has no published Caddy port (one-time migration)', async () => {
        const runtime = fakeRuntime({
            caddyPortless: true,
            existingNetworks: ['genie-ws-acme'],
            existing: [
                {
                    id: 'id-genie-ws-acme-dev',
                    name: 'genie-ws-acme-dev',
                    image: GENIE_DEV_BASE_IMAGE,
                    state: 'running',
                    workspaceId: 'acme',
                },
            ],
        });
        const result = await ensureWorkspaceSandbox('acme', WS_PATH, { runtime, platform: 'linux' });
        // The portless one is removed and a fresh, port-publishing one created.
        expect(runtime.removed).toContain('id-genie-ws-acme-dev');
        expect(result).toMatchObject({ ok: true, created: { container: true } });
        expect(runtime.ran[0]?.ports).toEqual([{ container: CADDY_HTTPS_PORT, hostIp: '127.0.0.1' }]);
    });

    it('keeps the container alive across restarts and holds it open', async () => {
        const runtime = fakeRuntime();
        await ensureWorkspaceSandbox('acme', WS_PATH, { runtime, platform: 'linux' });
        // A dev container with no foreground process exits immediately, and a
        // sandbox that dies the moment it is made is not a sandbox.
        expect(runtime.ran[0]?.command?.length).toBeGreaterThan(0);
        expect(runtime.ran[0]?.restart).toBe('unless-stopped');
    });

    it('is idempotent — a second call adopts the running container', async () => {
        const runtime = fakeRuntime();

        const first = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
        });
        const second = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
        });

        expect(first).toMatchObject({ ok: true, created: { network: true, container: true } });
        expect(second).toMatchObject({ ok: true, created: { network: false, container: false } });
        expect(runtime.ran).toHaveLength(1);
    });

    it('restarts an existing dev container that had exited', async () => {
        const runtime = fakeRuntime({
            existingNetworks: ['genie-ws-acme'],
            existing: [
                {
                    id: 'id-genie-ws-acme-dev',
                    name: 'genie-ws-acme-dev',
                    image: GENIE_DEV_BASE_IMAGE,
                    state: 'exited',
                    workspaceId: 'acme',
                },
            ],
        });

        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
        });

        expect(result).toMatchObject({ ok: true, created: { container: false } });
        expect(runtime.started).toEqual(['id-genie-ws-acme-dev']);
        expect(runtime.ran).toHaveLength(0);
    });

    it('ignores another workspace container that happens to be on the runtime', async () => {
        const runtime = fakeRuntime({
            existing: [
                {
                    id: 'id-other',
                    name: 'genie-ws-other-dev',
                    image: GENIE_DEV_BASE_IMAGE,
                    state: 'running',
                    workspaceId: 'other',
                },
            ],
        });

        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
        });

        expect(result).toMatchObject({ ok: true, created: { container: true } });
        expect(runtime.ran[0]?.name).toBe('genie-ws-acme-dev');
    });

    it('returns the guided-install path when no runtime is installed', async () => {
        const runtime = fakeRuntime({
            detection: {
                kind: 'none',
                reason: 'not-installed',
                installHint: 'Install Docker Desktop …',
                probes: [],
            },
        });

        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'win32',
        });

        expect(result).toMatchObject({
            ok: false,
            reason: 'runtime-unavailable',
            installHint: 'Install Docker Desktop …',
        });
        expect(runtime.networks.size).toBe(0);
        expect(runtime.ran).toHaveLength(0);
    });

    it('says the engine is not RUNNING when that is the truth', async () => {
        const runtime = fakeRuntime({
            detection: {
                kind: 'none',
                reason: 'not-running',
                installHint: 'Docker is installed but not running — start Docker Desktop.',
                probes: [],
            },
        });

        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'win32',
        });

        expect(result).toMatchObject({ ok: false, reason: 'runtime-unavailable' });
        if (result.ok) throw new Error('unreachable');
        expect(result.message).toMatch(/not running/i);
    });

    it('reports a missing dev image without starting anything', async () => {
        const runtime = fakeRuntime({ imagePresent: false });

        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
        });

        expect(result).toMatchObject({ ok: false, reason: 'image-missing' });
        if (result.ok) throw new Error('unreachable');
        // The message has to name the image AND the way out of it — a bare
        // "image missing" is a dead end for a user and for an agent.
        expect(result.message).toContain(GENIE_DEV_BASE_IMAGE);
        expect(result.message).toMatch(/pull/i);
        expect(runtime.ran).toHaveLength(0);
    });

    // --- P2: the missing image can now be FETCHED, with consent -------------

    it('asks for consent and PULLS the missing image when it is granted', async () => {
        const runtime = fakeRuntime({ imagePresent: false });
        const asked: string[] = [];
        const progress: string[] = [];

        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
            confirmImagePull: async (req) => {
                asked.push(req.image);
                return true;
            },
            onImagePullProgress: (chunk) => progress.push(chunk),
        });

        expect(asked).toEqual([GENIE_DEV_BASE_IMAGE]);
        expect(runtime.pulled).toEqual([GENIE_DEV_BASE_IMAGE]);
        expect(result).toMatchObject({ ok: true, pulledImage: true });
        expect(runtime.ran).toHaveLength(1);
        // The progress sink is threaded to the runtime, not swallowed here.
        expect(progress).toEqual([]);
    });

    it('does NOT pull when consent is refused, and says so', async () => {
        // A multi-gigabyte download is not something an app starts because a
        // user opened a workspace.
        const runtime = fakeRuntime({ imagePresent: false });
        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
            confirmImagePull: async () => false,
        });

        expect(runtime.pulled).toEqual([]);
        expect(result).toMatchObject({ ok: false, reason: 'image-pull-declined' });
        expect(runtime.ran).toHaveLength(0);
    });

    it('never pulls when there is no consent seam at all', async () => {
        // The default has to stay P1's: report it, don't fetch it. A caller that
        // forgot to wire a consent surface must not get a silent download.
        const runtime = fakeRuntime({ imagePresent: false });
        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
        });
        expect(runtime.pulled).toEqual([]);
        expect(result).toMatchObject({ ok: false, reason: 'image-missing' });
    });

    it('reports a FAILED pull distinctly from a missing one', async () => {
        // "Not here" and "we tried and the registry said no" need different
        // advice, so they cannot share a reason code.
        const runtime = fakeRuntime({ imagePresent: false, pullFails: 'manifest unknown' });
        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
            confirmImagePull: async () => true,
        });
        expect(result).toMatchObject({ ok: false, reason: 'image-pull-failed' });
        if (result.ok) throw new Error('unreachable');
        expect(result.message).toMatch(/manifest unknown/);
        expect(runtime.ran).toHaveLength(0);
    });

    // --- P2: host identity --------------------------------------------------

    it('hands the dev image the host uid/gid so bind-mounted files stay ours', async () => {
        // Without this the entrypoint cannot renumber its `genie` user, and
        // everything the container writes into the workspace comes out owned by
        // a uid the user cannot edit.
        const runtime = fakeRuntime();
        await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
            hostIds: { uid: 1000, gid: 1001 },
        });
        expect(runtime.ran[0]?.env).toMatchObject({ HOST_UID: '1000', HOST_GID: '1001' });
    });

    it('omits them where there are none (Windows has no uid)', async () => {
        const runtime = fakeRuntime();
        await ensureWorkspaceSandbox('acme', 'C:\\work\\acme', {
            runtime,
            platform: 'win32',
            hostIds: null,
        });
        expect(runtime.ran[0]?.env?.HOST_UID).toBeUndefined();
    });

    it('asks rootless PODMAN to keep the user id, and never asks docker', async () => {
        const podman = fakeRuntime({ kind: 'podman' });
        await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime: podman,
            platform: 'linux',
            hostIds: { uid: 1000, gid: 1000 },
        });
        expect(podman.ran[0]?.userns).toBe('keep-id');

        const docker = fakeRuntime();
        await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime: docker,
            platform: 'linux',
            hostIds: { uid: 1000, gid: 1000 },
        });
        expect(docker.ran[0]?.userns).toBeUndefined();
    });

    it('does not ask ROOTFUL podman to keep-id — it would refuse', async () => {
        // `--userns=keep-id` is rootless-only; as root it is an error, not a
        // no-op, so the flag is conditioned on a non-root uid.
        const podman = fakeRuntime({ kind: 'podman' });
        await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime: podman,
            platform: 'linux',
            hostIds: { uid: 0, gid: 0 },
        });
        expect(podman.ran[0]?.userns).toBeUndefined();
    });

    it('accepts any base image, so the sandbox is provable without the Genie image', async () => {
        const runtime = fakeRuntime();
        await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
            image: 'alpine:3.20',
        });
        expect(runtime.ran[0]?.image).toBe('alpine:3.20');
    });

    it('refuses a workspace path that cannot be bind-mounted', async () => {
        const runtime = fakeRuntime();

        const result = await ensureWorkspaceSandbox('acme', '\\\\nas\\share\\acme', {
            runtime,
            platform: 'win32',
        });

        expect(result).toMatchObject({ ok: false, reason: 'unsupported-path' });
        expect(runtime.ran).toHaveLength(0);
    });

    it('converts an exploding runtime into a failed status, not a throw', async () => {
        const runtime = fakeRuntime({ throwOn: 'runContainer' });

        const result = await ensureWorkspaceSandbox('acme', WS_PATH, {
            runtime,
            platform: 'linux',
        });

        expect(result).toMatchObject({ ok: false, reason: 'error' });
        if (result.ok) throw new Error('unreachable');
        expect(result.message).toContain('exploded');
    });
});

// --- teardown ---------------------------------------------------------------

describe('teardownWorkspaceSandbox', () => {
    it('removes every container in the workspace and then its network', async () => {
        const runtime = fakeRuntime();
        await ensureWorkspaceSandbox('acme', WS_PATH, { runtime, platform: 'linux' });

        const result = await teardownWorkspaceSandbox('acme', { runtime });

        expect(result).toEqual({ removedContainers: 1, removedNetwork: true, errors: [] });
        expect(runtime.removed).toEqual(['id-genie-ws-acme-dev']);
        expect(runtime.removedNetworks).toEqual(['genie-ws-acme']);
        expect(runtime.containers.size).toBe(0);
    });

    it('leaves other workspaces alone', async () => {
        const runtime = fakeRuntime();
        await ensureWorkspaceSandbox('acme', WS_PATH, { runtime, platform: 'linux' });
        await ensureWorkspaceSandbox('other', '/repos/other', { runtime, platform: 'linux' });

        await teardownWorkspaceSandbox('acme', { runtime });

        expect([...runtime.containers.keys()]).toEqual(['genie-ws-other-dev']);
        expect(runtime.networks.has('genie-ws-other')).toBe(true);
    });

    it('is idempotent — tearing down nothing is success', async () => {
        const runtime = fakeRuntime();
        expect(await teardownWorkspaceSandbox('acme', { runtime })).toEqual({
            removedContainers: 0,
            removedNetwork: true,
            errors: [],
        });
        expect(await teardownWorkspaceSandbox('acme', { runtime })).toMatchObject({ errors: [] });
    });

    it('does nothing at all when there is no container runtime', async () => {
        const runtime = fakeRuntime({
            detection: { kind: 'none', reason: 'not-installed', probes: [] },
        });

        const result = await teardownWorkspaceSandbox('acme', { runtime });

        expect(result).toEqual({ removedContainers: 0, removedNetwork: false, errors: [] });
        expect(runtime.removedNetworks).toEqual([]);
    });

    it('collects errors instead of aborting the sweep', async () => {
        // Workspace removal must complete even when one container refuses to
        // go: the alternative is a half-torn-down workspace and a user with no
        // way to finish it.
        const runtime = fakeRuntime({ throwOn: 'ps' });

        const result = await teardownWorkspaceSandbox('acme', { runtime });

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('exploded');
    });
});

// --- P3: teardown must let go of a SHARED service engine --------------------

describe('teardown with a shared service engine attached', () => {
    it('detaches every service engine before removing the workspace network', async () => {
        // A shared engine joins each consuming workspace's network, and Docker
        // refuses to remove a network that still has a container on it. Without
        // this the workspace would be left with an undeletable network — and
        // the engine, which belongs to no workspace, must survive.
        const runtime = fakeRuntime();
        runtime.networks.add('genie-ws-acme');
        const disconnected: { network: string; id: string }[] = [];
        const engine = {
            id: 'id-genie-svc-postgres-16',
            name: 'genie-svc-postgres-16',
            image: 'postgres:16-alpine',
            state: 'running' as const,
        };
        const withEngine: ContainerRuntime = {
            ...runtime,
            async psServices() {
                return [engine];
            },
            async networkDisconnect(network, id) {
                disconnected.push({ network, id });
            },
        };

        const result = await teardownWorkspaceSandbox('acme', { runtime: withEngine });

        expect(disconnected).toEqual([{ network: 'genie-ws-acme', id: engine.id }]);
        expect(result.removedNetwork).toBe(true);
        // The engine itself is untouched: it is not this workspace's to remove.
        expect(runtime.removed).not.toContain(engine.id);
    });

    it('still tears down when the engine listing fails', async () => {
        const runtime = fakeRuntime();
        const broken: ContainerRuntime = {
            ...runtime,
            async psServices() {
                throw new Error('engine listing exploded');
            },
        };
        const result = await teardownWorkspaceSandbox('acme', { runtime: broken });
        expect(result.removedNetwork).toBe(true);
    });
});
