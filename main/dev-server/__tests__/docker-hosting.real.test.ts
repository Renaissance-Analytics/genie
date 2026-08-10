import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createDockerRuntime } from '../docker-adapter';
import type { ContainerRef, ContainerRuntime } from '../container-runtime';
import { waitForHttp, waitForPort } from '../port-probe';

/**
 * REAL Docker hosting tests — drive Genie's ACTUAL container runtime
 * (`createDockerRuntime` → the `docker` CLI adapter) against a REAL daemon, for the
 * two container paths the mocked hosting E2E can't touch:
 *
 *   - a SERVICE engine (redis — Genie's own catalog image) comes up, is queryable
 *     from INSIDE via `exec`, AND its published loopback port is reachable from the
 *     host (the exact thing a site's injected DATABASE_URL / localAddress relies on —
 *     the "site can't reach its service" class, moic #169);
 *   - a CONTAINER SITE (nginx) actually SERVES HTTP on its host-published loopback
 *     port (the "loads in the in-app browser but not the local one" class — the port
 *     never reaching the host).
 *
 * These run the SAME runContainer / exec / portMappings a real `manageSite` /
 * `manageService` does, so a regression in Genie's Docker argv, port publishing, or
 * exec fails CI rather than the owner's afternoon. Own lane (`npm run test:hosting`,
 * the Linux CI `hosting` job has Docker), NOT the fast unit `npm test`.
 *
 * Every container is uniquely named + labelled and torn down in afterEach, so this
 * never touches the machine's real `genie-*` sandboxes or services.
 */

const REDIS_IMAGE = 'redis:7-alpine';
const WEB_IMAGE = 'nginx:alpine';
const LABEL = { 'genie.realtest': '1' };

/** Is a Docker daemon actually reachable? (The CLI stays on PATH when Docker
 *  Desktop is stopped, so probe the ENGINE, not the binary.) Skips rather than
 *  fails where there is no daemon; the CI hosting job always has one. */
const hasDocker = (() => {
    try {
        return (
            spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
                stdio: 'ignore',
                timeout: 15_000,
            }).status === 0
        );
    } catch {
        return false;
    }
})();

const rt: ContainerRuntime = createDockerRuntime();
const started: ContainerRef[] = [];
// A per-run suffix so a name never collides with a real genie-* container or a
// leftover from a crashed run. (Date.now/Math.random are fine in a test.)
const nonce = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
// One throwaway WORKSPACE network for the whole suite — the same seam a workspace's
// sandbox joins. A machine-scoped (workspaceId null) container must name its network;
// running on a real workspace network is both faithful and cleanly removable.
const WORKSPACE = `realtest-${nonce()}`;

async function ensureImage(image: string): Promise<void> {
    if (!(await rt.imageExists(image))) await rt.pullImage(image);
}

/** runContainer on the suite's workspace network + track it for teardown. */
async function run(image: string, ports: number[], name: string): Promise<ContainerRef> {
    const ref = await rt.runContainer({
        workspaceId: WORKSPACE,
        name,
        image,
        ports: ports.map((container) => ({ container })),
        labels: LABEL,
    });
    started.push(ref);
    return ref;
}

/** The host loopback port the runtime published for a container port. */
async function hostPortFor(ref: ContainerRef, containerPort: number): Promise<number> {
    const maps = await rt.portMappings(ref.id);
    const m = maps.find((x) => x.container === containerPort);
    expect(m, `container port ${containerPort} must be published to the host`).toBeTruthy();
    return m!.hostPort;
}

beforeAll(async () => {
    if (!hasDocker) return;
    await ensureImage(REDIS_IMAGE);
    await ensureImage(WEB_IMAGE);
    await rt.networkEnsure(WORKSPACE);
}, 120_000);

afterEach(async () => {
    for (const ref of started.splice(0)) {
        await rt.stop(ref.id).catch(() => {});
        await rt.remove(ref.id).catch(() => {});
    }
});

afterAll(async () => {
    if (hasDocker) await rt.networkRemove(WORKSPACE).catch(() => {});
});

describe('REAL Docker service — a redis engine runs, answers, and is host-reachable', () => {
    it.skipIf(!hasDocker)('runs, responds to redis-cli via exec, and publishes a reachable port', async () => {
        const ref = await run(REDIS_IMAGE, [6379], `genie-realtest-redis-${nonce()}`);

        // Reachable from the HOST on the published loopback port — the exact hop a
        // site's injected localAddress / connection string makes. Waited FIRST so the
        // engine is listening before we query it (no start-race).
        const hostPort = await hostPortFor(ref, 6379);
        expect(await waitForPort(hostPort, 20_000), 'the published redis port must accept a TCP connection').toBe(
            true,
        );

        // Queryable from INSIDE (what provisioning + healthchecks use).
        const ping = await rt.exec(ref.id, ['redis-cli', 'ping']);
        expect(ping.stdout).toContain('PONG');
        await rt.exec(ref.id, ['redis-cli', 'set', 'genie', 'REDIS-REAL-OK']);
        const got = await rt.exec(ref.id, ['redis-cli', 'get', 'genie']);
        expect(got.stdout).toContain('REDIS-REAL-OK');
    });
});

describe('REAL Docker container site — an image actually SERVES HTTP on its host port', () => {
    it.skipIf(!hasDocker)('serves its own content on the published loopback port', async () => {
        const marker = 'CONTAINER-SITE-REAL-OK';
        const ref = await run(WEB_IMAGE, [80], `genie-realtest-web-${nonce()}`);
        // Give the container its OWN content via exec (no host bind-mount to keep it
        // OS-neutral); nginx reads the file per request.
        await rt.exec(ref.id, [
            'sh',
            '-c',
            `printf '%s' '${marker}' > /usr/share/nginx/html/index.html`,
        ]);

        const hostPort = await hostPortFor(ref, 80);
        expect(await waitForHttp(hostPort, 20_000), 'the container must answer HTTP on its host port').toBe(true);
        const body = await fetch(`http://127.0.0.1:${hostPort}/`).then((r) => r.text());
        expect(body).toContain(marker);
    });

    it.skipIf(!hasDocker)('two container sites each serve their OWN app on distinct host ports', async () => {
        // The moic.gen "wrong app" class at the container layer: two sites must get
        // distinct published ports and never cross-serve.
        const [a, b] = await Promise.all([
            run(WEB_IMAGE, [80], `genie-realtest-web-a-${nonce()}`),
            run(WEB_IMAGE, [80], `genie-realtest-web-b-${nonce()}`),
        ]);
        await rt.exec(a.id, ['sh', '-c', "printf '%s' 'WEB-A' > /usr/share/nginx/html/index.html"]);
        await rt.exec(b.id, ['sh', '-c', "printf '%s' 'WEB-B' > /usr/share/nginx/html/index.html"]);
        const [pa, pb] = await Promise.all([hostPortFor(a, 80), hostPortFor(b, 80)]);
        expect(pa).not.toBe(pb);
        expect(await waitForHttp(pa, 20_000)).toBe(true);
        expect(await waitForHttp(pb, 20_000)).toBe(true);
        const [ba, bb] = await Promise.all([
            fetch(`http://127.0.0.1:${pa}/`).then((r) => r.text()),
            fetch(`http://127.0.0.1:${pb}/`).then((r) => r.text()),
        ]);
        expect(ba).toContain('WEB-A');
        expect(ba).not.toContain('WEB-B');
        expect(bb).toContain('WEB-B');
        expect(bb).not.toContain('WEB-A');
    });
});
