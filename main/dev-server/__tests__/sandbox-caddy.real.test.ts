import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createDockerRuntime } from '../docker-adapter';
import type { ContainerRef, ContainerRuntime } from '../container-runtime';
import { applyCaddyConfig, CADDY_DIR } from '../caddy-proxy';
import { CADDY_HTTPS_PORT } from '../caddyfile';
import { waitForHttpsSni } from '../port-probe';

/**
 * REAL sandbox-Caddy test — the beta.230 bug class, reproduced.
 *
 * beta.230 shipped GREEN (unit + mocked E2E) yet took every hosted site down,
 * because three bugs only a REAL container running as the NON-ROOT sandbox user
 * reveals slipped through (see feedback_real_docker_test_hosting_before_ship):
 *   1. `/run/genie-caddy` mkdir EACCES as non-root (fixed → `/tmp/genie-caddy`);
 *   2. Caddy's `tls internal` CA can't write `$HOME/.local/share` as non-root
 *      (fixed → XDG_DATA_HOME at a writable dir);
 *   3. the started Caddy inheriting the `docker exec` pipe → EPIPE on its first
 *      request (fixed → `setsid` + a log file).
 *
 * This drives the REAL `applyCaddyConfig` against a REAL container running as a
 * NON-ROOT user (uid 1000, like the sandbox's renumbered `genie`), then dials the
 * in-sandbox Caddy over TLS with SNI. If any of the three fixes regressed, Caddy
 * never comes up as non-root and the SNI dial fails — which is exactly the outage.
 *
 * It uses Genie's OWN bundled Caddy (from `resources/runtime/caddy`, produced by
 * `npm run build:runtime`; a `GENIE_TEST_CADDY_LINUX` override lets a Windows box
 * validate with a cross-built copy) baked into a `USER 1000` image over the stock
 * `caddy` image's busybox userland. The bundled binary is required, not incidental:
 * `buildCaddyfile` emits the `replace` directive from the caddyserver/replace-response
 * module baked ONLY into Genie's Caddy — so this also proves the real config parses.
 *
 * Own lane (`npm run test:hosting`, the CI Linux `hosting` job builds the runtime).
 * Skips unless Docker is up AND the resolved Caddy is a Linux binary (so it runs on
 * CI Linux; a Windows dev box skips unless it sets the override).
 */

const CADDY_IMAGE = 'caddy:2-alpine'; // just the busybox userland; the bundled caddy overrides it
const LABEL = { 'genie.realtest': '1' };
const NONROOT_UID = 1000;

/** Genie's bundled Caddy (with the replace-response module), Linux build. */
const BUNDLED_CADDY =
    process.env.GENIE_TEST_CADDY_LINUX || path.resolve(process.cwd(), 'resources', 'runtime', 'caddy');

/** True iff `p` starts with the ELF magic — i.e. a Linux binary we can run in a
 *  Linux container (a Windows `caddy.exe` is a PE and would just fail to exec). */
function isLinuxElf(p: string): boolean {
    try {
        const fd = openSync(p, 'r');
        try {
            const buf = Buffer.alloc(4);
            readSync(fd, buf, 0, 4, 0);
            return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
        } finally {
            closeSync(fd);
        }
    } catch {
        return false;
    }
}

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

const canRun = hasDocker && isLinuxElf(BUNDLED_CADDY);

const rt: ContainerRuntime = createDockerRuntime();
const nonce = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const WORKSPACE = `realtest-sbx-${nonce()}`;
const IMAGE_TAG = `genie-realtest-sandbox:${nonce()}`;
const started: ContainerRef[] = [];

/** Poll a shell test INSIDE the container until it exits 0 (or the budget runs out). */
async function pollInside(cid: string, shellTest: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const r = await rt.exec(cid, ['sh', '-c', shellTest]);
        if (r.code === 0) return true;
        await new Promise((res) => setTimeout(res, 1000));
    }
    return false;
}

/** A raw HTTPS GET that presents `servername` as SNI (Caddy routes by it) and
 *  trusts the internal CA — the exact dial the in-app carrier makes. */
function sniGet(port: number, servername: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                host: '127.0.0.1',
                port,
                path: '/',
                servername,
                rejectUnauthorized: false,
                headers: { Host: servername },
            },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            },
        );
        req.on('error', reject);
        req.end();
    });
}

beforeAll(async () => {
    if (!canRun) return;
    // A non-root image carrying Genie's OWN bundled Caddy — exactly how the dev
    // sandbox runs the `genie` user (the ContainerRuntime has no --user, so the
    // USER directive is where non-root comes from). RUN chmod runs as root, before
    // the USER switch, so the copied binary is executable.
    const ctx = mkdtempSync(path.join(tmpdir(), 'genie-sbx-img-'));
    copyFileSync(BUNDLED_CADDY, path.join(ctx, 'caddy'));
    writeFileSync(
        path.join(ctx, 'Dockerfile'),
        `FROM ${CADDY_IMAGE}\n` +
            `COPY caddy /usr/local/bin/caddy\n` +
            `RUN chmod 0755 /usr/local/bin/caddy\n` +
            `USER ${NONROOT_UID}:${NONROOT_UID}\n`,
    );
    try {
        await rt.buildImage({ tag: IMAGE_TAG, context: ctx });
    } finally {
        rmSync(ctx, { recursive: true, force: true });
    }
    await rt.networkEnsure(WORKSPACE);
}, 180_000);

afterEach(async () => {
    for (const ref of started.splice(0)) {
        await rt.stop(ref.id).catch(() => {});
        await rt.remove(ref.id).catch(() => {});
    }
});

afterAll(async () => {
    if (!canRun) return;
    await rt.networkRemove(WORKSPACE).catch(() => {});
    spawnSync('docker', ['rmi', '-f', IMAGE_TAG], { stdio: 'ignore', timeout: 30_000 });
});

describe('REAL sandbox Caddy — applyCaddyConfig starts + serves TLS-SNI as the NON-ROOT user', () => {
    it.skipIf(!canRun)('comes up as non-root, provisions its internal CA, and serves over SNI', async () => {
        const host = 'sandbox.realtest.gen';
        const ref = await rt.runContainer({
            workspaceId: WORKSPACE,
            name: `genie-realtest-sandbox-${nonce()}`,
            image: IMAGE_TAG,
            command: ['sleep', '3600'],
            ports: [{ container: CADDY_HTTPS_PORT }],
            labels: LABEL,
        });
        started.push(ref);

        // NOT vacuous: prove we are actually exercising the non-root path (uid 1000).
        // If this ran as root, /run would be writable and none of the beta.230 fixes
        // would be under test.
        const who = await rt.exec(ref.id, ['id', '-u']);
        expect(who.stdout.trim(), 'the sandbox must run as a NON-ROOT user').not.toBe('0');
        expect(who.stdout.trim()).toBe(String(NONROOT_UID));

        // A trivial upstream on a loopback port for the proxy to reach — a stand-in
        // for the site process. Detached the same way site-process.ts detaches.
        await rt.exec(ref.id, [
            'sh',
            '-c',
            "mkdir -p /tmp/up && printf '%s' 'SANDBOX-SITE-OK' > /tmp/up/index.html && " +
                'setsid caddy file-server --root /tmp/up --listen 127.0.0.1:9000 ' +
                '>/tmp/up/caddy.log 2>&1 </dev/null &',
        ]);
        const upReady = await pollInside(
            ref.id,
            'wget -qO- http://127.0.0.1:9000/ 2>/dev/null | grep -q SANDBOX-SITE-OK',
            15_000,
        );
        expect(upReady, 'the in-sandbox upstream must come up').toBe(true);

        // THE call under test: the real caddy-proxy converge, run inside the
        // container as uid 1000 (docker exec inherits the image USER).
        const applied = await applyCaddyConfig(rt, ref.id, [{ host, port: 9000 }]);
        expect(applied, `applyCaddyConfig must succeed as non-root: ${JSON.stringify(applied)}`).toEqual({
            ok: true,
        });

        // The sandbox Caddy binds 8443; dial its published host port with SNI. This
        // succeeds ONLY if Caddy started (the /tmp + XDG fixes) AND stayed up past the
        // exec close (the setsid fix) AND provisioned its `tls internal` CA as non-root.
        const maps = await rt.portMappings(ref.id);
        const hostPort = maps.find((m) => m.container === CADDY_HTTPS_PORT)?.hostPort;
        expect(hostPort, 'the sandbox Caddy 8443 must be published').toBeTruthy();
        const sniUp = await waitForHttpsSni(hostPort!, host, 25_000);
        if (!sniUp) {
            const log = await rt.exec(ref.id, ['sh', '-c', `cat ${CADDY_DIR}/caddy.log 2>/dev/null | tail -25`]);
            throw new Error(
                `SNI dial to 8443 (host ${hostPort}) failed. caddy.log:\n${log.stdout}${log.stderr}`,
            );
        }

        // And it serves the proxied site end-to-end (proxy → upstream → body).
        const res = await sniGet(hostPort!, host);
        expect(res.status).toBe(200);
        expect(res.body).toContain('SANDBOX-SITE-OK');

        // Belt-and-braces: the tls-internal CA really was written under the writable
        // XDG dir (the beta.230 fix), not a root-owned path.
        const ca = await rt.exec(ref.id, [
            'sh',
            '-c',
            `ls ${CADDY_DIR}/data/caddy/pki/authorities 2>/dev/null`,
        ]);
        expect(ca.stdout, 'the tls-internal CA must be written under the writable XDG dir').toContain('local');
    });
});
