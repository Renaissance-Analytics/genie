import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { buildHostCaddyfile } from '../host-caddyfile';

/**
 * REAL host-Caddy WEBSOCKET test — a `.gen` page could not hold a socket open.
 *
 * The reported symptom was the confusing one: the socket REACHED `onopen` and
 * then no frame ever arrived, so Laravel Echo sat at "unavailable" forever. That
 * reads like a broken upgrade and is not one — the upgrade succeeds and the body
 * rewriter eats everything after it.
 *
 * ## Why this test has to speak HTTP/2
 *
 * The defect needs BOTH the `replace` directive AND h2, and neither alone shows
 * it. An ordinary WebSocket client — including every `ws` library and a raw
 * socket — negotiates HTTP/1.1, where `replace` is harmless. A test written that
 * way passes identically with the bug present and with it fixed: green, and
 * proving nothing.
 *
 * h2 is not exotic on this front door, it is the norm. Every `.gen` name shares
 * ONE leaf certificate on ONE address, so a browser COALESCES a socket to
 * `websockets.<ws>.gen` onto the h2 connection it already holds for the page and
 * sends it as an RFC 8441 Extended CONNECT stream (`:method: CONNECT` +
 * `:protocol: websocket`). That is what this test does, with `node:http2` — the
 * same wire protocol the browser used, and no browser anywhere near it.
 *
 * ## What makes it non-vacuous
 *
 * It runs BOTH configurations against the same real Caddy and the same upstream:
 * the shipped one from `buildHostCaddyfile`, and a deliberately UNGATED `replace`
 * that is what the code did before the fix. The unfixed one must go silent. If a
 * future change made this whole harness unable to see frames, that control would
 * stop failing and this test would tell you so, instead of passing forever.
 *
 * Own lane (`npm run test:hosting` → the CI Linux `hosting` job), because it runs
 * Genie's REAL bundled Caddy. Skips when that binary or `openssl` is absent.
 */

/** The bundled Caddy — the only build carrying the replace-response module the
 *  generated config uses, so this also proves the real config parses. */
const BUNDLED_CADDY = (() => {
    const base = path.resolve(process.cwd(), 'resources', 'runtime');
    for (const name of ['caddy', 'caddy.exe']) {
        const p = path.join(base, name);
        if (fs.existsSync(p)) return p;
    }
    return process.env.GENIE_TEST_CADDY ?? '';
})();

const hasOpenssl = (() => {
    try {
        return spawnSync('openssl', ['version'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
    } catch {
        return false;
    }
})();

const canRun = Boolean(BUNDLED_CADDY) && fs.existsSync(BUNDLED_CADDY) && hasOpenssl;

const HOST = 'wstest.local';
/** The one frame the upstream sends the instant the handshake completes — the
 *  shape of Sockudo's `pusher:connection_established` greeting. */
const GREETING = 'GREETING';

/** A port nothing is listening on, learned by binding :0 and letting go. */
async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });
}

/** A WebSocket upstream that completes the handshake and immediately sends one
 *  text frame. Deliberately hand-rolled: the point is the bytes on the wire. */
function startUpstream(port: number): http.Server {
    const server = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('http-ok');
    });
    // Killing Caddy at teardown resets every connection it still holds to this
    // upstream. An unhandled 'error' on a socket is an UNCAUGHT exception in the
    // test process, which fails the run even though every assertion passed — so
    // the reset is expected here, and swallowed.
    server.on('connection', (s) => s.on('error', () => {}));
    server.on('upgrade', (req, socket) => {
        socket.on('error', () => {});
        const accept = crypto
            .createHash('sha1')
            .update(String(req.headers['sec-websocket-key'] ?? '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
                `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        const payload = Buffer.from(GREETING);
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
    server.listen(port, '127.0.0.1');
    return server;
}

/**
 * Open a WebSocket the way a browser does over a coalesced h2 connection, and
 * report what came back.
 *
 * `opened` is the half that makes the bug legible: with the rewriter in the way
 * the stream OPENS and stays empty, which is why the report said "connects, then
 * unavailable" rather than "refused".
 */
async function h2WebSocket(
    port: number,
    caPath: string,
    waitMs = 20_000,
): Promise<{ opened: boolean; connectProtocol: boolean; data: string | null }> {
    const ca = fs.readFileSync(caPath);
    const client = http2.connect(`https://${HOST}:${port}`, {
        createConnection: () => {
            const socket = tls.connect({
                host: '127.0.0.1',
                port,
                servername: HOST,
                ca: [ca],
                ALPNProtocols: ['h2'],
            });
            // Same reason as the upstream: a reset at teardown must not become an
            // uncaught exception and fail a run whose assertions all passed.
            socket.on('error', () => {});
            return socket;
        },
    });
    return new Promise((resolve) => {
        let connectProtocol = false;
        let opened = false;
        const done = (data: string | null) => {
            clearTimeout(timer);
            try {
                client.close();
            } catch {
                /* the verdict is already decided */
            }
            resolve({ opened, connectProtocol, data });
        };
        const timer = setTimeout(() => done(null), waitMs);
        client.on('remoteSettings', (s) => {
            connectProtocol = Boolean(s.enableConnectProtocol);
        });
        client.on('error', () => done(null));
        client.on('connect', () => {
            const req = client.request({
                ':method': 'CONNECT',
                ':protocol': 'websocket',
                ':scheme': 'https',
                ':path': '/ws',
                ':authority': `${HOST}:${port}`,
                'sec-websocket-version': '13',
                origin: `https://${HOST}`,
            });
            req.on('response', (h) => {
                if (h[':status'] === 200) opened = true;
            });
            // Strip the 2-byte unmasked text-frame header the upstream wrote.
            req.on('data', (d: Buffer) => done(d.subarray(2).toString()));
            req.on('error', () => done(null));
        });
    });
}

/**
 * Make the generated config runnable in a test: move the privileged ports, and
 * turn the admin endpoint off.
 *
 * The vhost BODY — the part under test — is left exactly as `buildHostCaddyfile`
 * emitted it. Only the global block and the listen ports move, and both have to:
 * :80 and :443 need root on a CI runner, and Caddy's admin endpoint is a FIXED
 * :2019, so without `admin off` the two instances here collide with each other
 * (and with the developer's own running Genie).
 */
function runnableInTest(caddyfile: string, httpsPort: number, httpPort: number): string {
    return caddyfile
        .replace(/:443 \{/g, `:${httpsPort} {`)
        .replace(/:80 \{/g, `:${httpPort} {`)
        .replace('{\n\tauto_https disable_redirects\n}', '{\n\tauto_https disable_redirects\n\tadmin off\n}');
}

/** Caddy's own output, kept so a CI failure says WHY rather than just "never
 *  came up" — the first run of this test failed on the admin-port collision and
 *  the reason was in a stream nobody was reading. */
const caddyLog = new Map<string, string>();

async function startCaddy(dir: string, config: string, label: string): Promise<ChildProcess> {
    const file = path.join(dir, `Caddyfile.${label}`);
    fs.writeFileSync(file, config);
    const proc = spawn(BUNDLED_CADDY, ['run', '--config', file, '--adapter', 'caddyfile'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Keep Caddy's state out of the developer's real Caddy data dir.
        env: { ...process.env, XDG_DATA_HOME: path.join(dir, 'xdg'), XDG_CONFIG_HOME: path.join(dir, 'xdg') },
    });
    caddyLog.set(label, '');
    const keep = (chunk: Buffer) =>
        caddyLog.set(label, (caddyLog.get(label) ?? '' + '').concat(chunk.toString()).slice(-4000));
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    return proc;
}

/** Poll until the TLS port answers, so the test never races Caddy's startup. */
async function waitForTls(port: number, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const up = await new Promise<boolean>((resolve) => {
            const s = tls.connect(
                { host: '127.0.0.1', port, servername: HOST, rejectUnauthorized: false },
                () => {
                    s.destroy();
                    resolve(true);
                },
            );
            s.on('error', () => resolve(false));
            s.setTimeout(1500, () => {
                s.destroy();
                resolve(false);
            });
        });
        if (up) return true;
        await new Promise((r) => setTimeout(r, 300));
    }
    return false;
}

describe.skipIf(!canRun)('the host front door carries a real WebSocket (genie: wss on .gen)', () => {
    let dir = '';
    let upstream: http.Server | null = null;
    let shipped: ChildProcess | null = null;
    let unfixed: ChildProcess | null = null;
    let shippedPort = 0;
    let unfixedPort = 0;
    let certPath = '';

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(tmpdir(), 'genie-wss-'));
        certPath = path.join(dir, 'cert.pem');
        const keyPath = path.join(dir, 'key.pem');
        // An args ARRAY, never a shell string: a `/CN=` subject is mangled into a
        // path by MSYS on a Windows dev box the moment a shell sees it.
        const gen = spawnSync(
            'openssl',
            [
                'req', '-x509', '-newkey', 'rsa:2048',
                '-keyout', keyPath, '-out', certPath,
                '-days', '2', '-nodes', '-subj', `/CN=${HOST}`,
                '-addext', `subjectAltName=DNS:${HOST},IP:127.0.0.1`,
            ],
            { stdio: 'ignore', timeout: 60_000 },
        );
        expect(gen.status, 'openssl could not mint a test certificate').toBe(0);

        const upstreamPort = await freePort();
        upstream = startUpstream(upstreamPort);

        shippedPort = await freePort();
        unfixedPort = await freePort();
        const site = { host: HOST, port: upstreamPort };
        const tlsPaths = { certPath, keyPath };

        // What Genie actually generates.
        shipped = await startCaddy(
            dir,
            runnableInTest(buildHostCaddyfile([site], tlsPaths), shippedPort, await freePort()),
            'shipped',
        );
        // The SAME config with the rewriter ungated — what the code emitted before
        // the fix. This is the control: it must fail, or this test proves nothing.
        unfixed = await startCaddy(
            dir,
            runnableInTest(buildHostCaddyfile([site], tlsPaths), unfixedPort, await freePort())
                .replace(/\t@rewritable \{\n(?:.*\n)*?\t\}\n/, '')
                .replace('replace @rewritable {', 'replace {'),
            'unfixed',
        );

        expect(
            await waitForTls(shippedPort),
            `shipped Caddy never came up:
${caddyLog.get('shipped')}`,
        ).toBe(true);
        expect(
            await waitForTls(unfixedPort),
            `control Caddy never came up:
${caddyLog.get('unfixed')}`,
        ).toBe(true);
    }, 120_000);

    afterAll(async () => {
        // Caddy first, then a beat for the resets it causes to land on the
        // upstream's (now error-handled) sockets, then the upstream itself.
        shipped?.kill();
        unfixed?.kill();
        await new Promise((r) => setTimeout(r, 300));
        upstream?.closeAllConnections?.();
        await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            /* Windows sometimes holds a handle briefly */
        }
    });

    it('delivers a frame over an HTTP/2 WebSocket — the path a browser actually takes', async () => {
        const res = await h2WebSocket(shippedPort, certPath);
        // If Caddy ever stopped advertising Extended CONNECT, this test would be
        // exercising HTTP/1.1 and quietly checking nothing.
        expect(res.connectProtocol, 'Caddy did not offer RFC 8441 Extended CONNECT').toBe(true);
        expect(res.opened, 'the CONNECT stream never opened').toBe(true);
        expect(res.data).toBe(GREETING);
    }, 60_000);

    it('CONTROL: with the rewriter ungated the stream opens and then goes silent', async () => {
        // The exact reported failure, and the reason the fix is a matcher rather
        // than a header tweak: nothing here is refused, the frames are eaten.
        // A shorter window than the happy path: we are waiting to be sure NOTHING
        // arrives, and the working config delivers in single-digit milliseconds.
        const res = await h2WebSocket(unfixedPort, certPath, 8_000);
        expect(res.opened, 'the control did not even open — the harness is wrong').toBe(true);
        expect(res.data).toBeNull();
    }, 60_000);
});
