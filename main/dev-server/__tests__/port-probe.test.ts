import net from 'node:net';
import https from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForHttp, waitForHttpsSni, waitForPort } from '../port-probe';

/**
 * READINESS — and the Docker Desktop trap that makes the obvious probe lie.
 *
 * A TCP connect looks like the right way to ask "has the dev server bound its
 * port?". On Linux it is. On Docker Desktop (Windows and macOS) it is NOT: the
 * published port is held open by Docker's own userland forwarder, which ACCEPTS
 * the connection whether or not anything inside the container is listening, and
 * then closes it when the forward fails.
 *
 * That was found by the live smoke, which reported `ready: true` for a container
 * whose python server had not finished starting — and then hung up on the very
 * next request. It is precisely the failure the `ready` field exists to prevent:
 * an agent telling a user "your site is live at https://web.acme.gen" and the
 * user getting a dead socket.
 *
 * So an HTTP surface is probed with a real HTTP request, and only a real
 * RESPONSE counts. The accept-then-close forwarder is modelled directly below,
 * because it is the case that broke.
 */

const servers: net.Server[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.close();
});

/** A long-lived self-signed cert/key (shared with the mobile site-proxy tests) —
 *  enough to stand up a TLS listener the SNI probe can terminate. */
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDMjCCAhqgAwIBAgIULF/syeRZbfjSyYcMTOPCKYgsnjswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJdHlubi50ZXN0MCAXDTI2MDcwMzIzMjcyNloYDzIxMjYw
NjA5MjMyNzI2WjAUMRIwEAYDVQQDDAl0eW5uLnRlc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDTj+J24kMh9gKWSsioYdC1aWbINuYxtBnBm+Sj8TQq
jxpkEiTCKZUp/JQKQYk2zsB33GWIgFkXILVHtbQZ5jw/ASFs7Tmeza+IZEn0S1S2
ykLQ8QLg4LHHDGavmWBop3YBg0HCIDndgZVrVZCRyjMJ+Pa8da9+7KTGaWdrgC7/
ofrBBqAdjHyx6bOViqUpgwlNEWzr4RFbsQbuXgcXxSljT3UdK0cNEzq1GlE+hLGv
Rdx7QYTReggC5exzRwPnprNA2M5bs0usB4njBzUzW2gq3SOg65BLPlhkCxhtq/Wq
j/DpJLjbR2veSlI/bMrfCs7HKQBfgTWv3g/M+5dmie03AgMBAAGjejB4MB0GA1Ud
DgQWBBT5Ci5yhX4vM9rKLxV9cNxYqgYtzTAfBgNVHSMEGDAWgBT5Ci5yhX4vM9rK
LxV9cNxYqgYtzTAPBgNVHRMBAf8EBTADAQH/MCUGA1UdEQQeMByCCXR5bm4udGVz
dIIJbG9jYWxob3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQBT9xjkclqJ8N2J
HN70gaMPB/3n6+dZoXbR5MVyBJq1QqyARznrQwxT1ysib+u1/opnfLIBkFfBDIVa
nlOLXLTnZ2z1zeSBfSFEAizKx9n7zhH5Y6wN3UhXZCrMhkKsBq0emPVk62zsVhSl
Nk1LFHgs6nkQV3ZrZrpGaC5lsVJrc57/gSMTiQQp+rqPDNQ7TTm443WJvNQh6474
k4vo6G6jdRVUJCDjMuOPYdTPdJjoV9k8V9ANHAq7yY1rmTaplIdeWv9KIf+Yqc6v
QQOzemqDnp9vUXTBUXrGXcohbxwr3x853Vb/bO7GWdTzanVs7ouYUPoKti8iQeTr
xsyQjUWF
-----END CERTIFICATE-----
`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDTj+J24kMh9gKW
SsioYdC1aWbINuYxtBnBm+Sj8TQqjxpkEiTCKZUp/JQKQYk2zsB33GWIgFkXILVH
tbQZ5jw/ASFs7Tmeza+IZEn0S1S2ykLQ8QLg4LHHDGavmWBop3YBg0HCIDndgZVr
VZCRyjMJ+Pa8da9+7KTGaWdrgC7/ofrBBqAdjHyx6bOViqUpgwlNEWzr4RFbsQbu
XgcXxSljT3UdK0cNEzq1GlE+hLGvRdx7QYTReggC5exzRwPnprNA2M5bs0usB4nj
BzUzW2gq3SOg65BLPlhkCxhtq/Wqj/DpJLjbR2veSlI/bMrfCs7HKQBfgTWv3g/M
+5dmie03AgMBAAECggEAY+SV8T1fpmrzCMTR3xOkiOv2MIYfhgt8d9rkh/ZNg+Ti
+KpKefVJbbRJsFgGcn8ICPBjbqLvrghvICdvHSWFf9hIUJbodI+5GKUF+FgTbWWu
S9ro2Yau2oYD/Fjm2TNs+ETiKUevGuRjSXVy2CvJkqVf11eYIE2bdeXyA6PYTTHx
dQs/bQMQhxPJt7cGOMd1LorlVbtF4JPeZGv2jXRElyE8iD0iYndF3M0xjZJgssAl
ZCsr/3yjqzQWvQoopUKRDRwFiUrPBcZzY213OcdhbPWuB4BqOgKOXYXM8HleWuXo
jgjD8OaQGibVXN+zOV/EjleEjg7xvYf3QeELtArfhQKBgQD7i7UJ8NIZGeCeYn6b
4nq0Zv55JC7VoGrDojW88P//u24lwYgzmO7v4F6MuxNMZQO2hLc0OWgol4zbwRkm
pUnARlCPV8xskOkeSwHm9wWa8SHWxT6B7DPDtUQLdNvBa7vK1RrOkkJ+K8IsuIka
l5mR7QOy7PgKVz9Yst8g2zFRmwKBgQDXTuz57li3CozWnGZsDIiXKhnrRkU0Rlf2
g7geMbd3c1todDTBlJDlWeSpYm48wYznq3nQLU+1AW6qip5+a26Yw/8vH+T3VRU8
bVJMzF6C5SHhPSjuqoQ+I7enuNlY1pnHpNUDtNbwh3Ft3PwVoSQcOiXO2vCECBcR
EAHrOnYqlQKBgE2/QJVx+X4IoYRSrQ9BUOuxabXHmTIuAtG0sSdU1csVA1ZoGtDX
1AIQNykIKU7TafJf0sAxfiANt1u0szFepQzorr2fRW/I2kSiqlPYxcK+BNd833UI
rHcw73cbB1EhG0n10/NFAYg9viZUYwv1D2Iq/5mt5HxNuyaPIqflF7lBAoGAOy8/
5wgErPQieM/vO55KYbs5+rmLRm5bubDFiM9DznsQUms3IUtUdSc7uvAKu3q83+X8
CySZd3kYUZrfLIMdmLKvz+VljDOALecjK2c2R6bypDaqrMiEp4wr7NfcLxZ2mTGP
OICaYO3qWTfYt51fDr9RK0Z1vOV4acFLtbyRRO0CgYBlZtyE311eJG53mPEyx8UQ
2CtL452JNRrsNzFqbpJVse1JGrZKJvPXNpWNpUy3apADkVMJQ2kAxnlwHvIQRM/y
IXnfYkdMpSOxAHTGsYRCtvqgRvvrHvozAhyzNseBvPvDILYpC76qiSGqaXi142bz
xGjX3WqZONEmsY83ZYhZwA==
-----END PRIVATE KEY-----
`;

/** Stand up an https listener whose status is decided per-request — the model of
 *  Caddy in front of an app that may not have bound yet. */
function listenTls(status: () => number): Promise<number> {
    const server = https.createServer({ cert: TEST_CERT, key: TEST_KEY }, (_req, res) => {
        res.writeHead(status());
        res.end('x');
    });
    servers.push(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
}

/** Listen on an ephemeral port with the given connection behaviour. */
function listen(onConnection: (socket: net.Socket) => void): Promise<number> {
    const server = net.createServer(onConnection);
    servers.push(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as net.AddressInfo).port);
        });
    });
}

/** An unused loopback port. Bind one, read it, release it. */
async function closedPort(): Promise<number> {
    const port = await listen(() => {});
    servers.pop()?.close();
    return port;
}

describe('waitForPort — the TCP probe', () => {
    it('is true when something accepts', async () => {
        const port = await listen((socket) => socket.destroy());
        expect(await waitForPort(port, 2_000)).toBe(true);
    });

    it('is false, not a throw, when nothing is listening', async () => {
        expect(await waitForPort(await closedPort(), 300)).toBe(false);
    });
});

describe('waitForHttp — what an HTTP surface actually needs', () => {
    it('is true when the server answers with a status line', async () => {
        const port = await listen((socket) => {
            socket.on('data', () => {
                socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi');
            });
        });
        expect(await waitForHttp(port, 2_000)).toBe(true);
    });

    it('counts an ERROR status as ready — the server is up, that is the question', async () => {
        // A framework rejecting our Host, or a 500 from a half-migrated app, is
        // still a dev server that has bound its port.
        const port = await listen((socket) => {
            socket.on('data', () => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
        });
        expect(await waitForHttp(port, 2_000)).toBe(true);
    });

    it('is FALSE for a socket that accepts and then hangs up', async () => {
        // THE DOCKER DESKTOP CASE. The TCP probe says yes here; that is the lie.
        const port = await listen((socket) => socket.destroy());
        expect(await waitForPort(port, 500)).toBe(true);
        expect(await waitForHttp(port, 1_000)).toBe(false);
    });

    it('is false when nothing is listening at all', async () => {
        expect(await waitForHttp(await closedPort(), 300)).toBe(false);
    });

    it('keeps trying until the server comes up inside the budget', async () => {
        // The whole point: a dev server that takes a second to bind is READY,
        // and one that never does is not — both within one bounded call.
        let answering = false;
        const port = await listen((socket) => {
            if (!answering) {
                socket.destroy();
                return;
            }
            socket.on('data', () => socket.end('HTTP/1.1 200 OK\r\n\r\n'));
        });
        setTimeout(() => {
            answering = true;
        }, 400);
        expect(await waitForHttp(port, 5_000)).toBe(true);
    });
});

describe('waitForHttpsSni — readiness THROUGH the sandbox Caddy', () => {
    it('is ready when the vhost behind Caddy answers a real status over TLS+SNI', async () => {
        const port = await listenTls(() => 200);
        expect(await waitForHttpsSni(port, 'web.acme.gen', 2_000)).toBe(true);
    });

    it('treats a Caddy 502/503/504 as NOT ready — the app has not bound yet', async () => {
        // Through-Caddy, a gateway status is Caddy itself saying the upstream is
        // down. Counting it as "answered" is exactly the false-positive `ready`
        // exists to prevent — so unlike a direct HTTP probe, it must be false.
        const port = await listenTls(() => 502);
        expect(await waitForHttpsSni(port, 'web.acme.gen', 500)).toBe(false);
    });

    it('flips to ready once Caddy stops 502ing and the app answers', async () => {
        let up = false;
        const port = await listenTls(() => (up ? 200 : 503));
        setTimeout(() => {
            up = true;
        }, 400);
        expect(await waitForHttpsSni(port, 'web.acme.gen', 5_000)).toBe(true);
    });

    it('is false, not a throw, when nothing is listening', async () => {
        expect(await waitForHttpsSni(await closedPort(), 'web.acme.gen', 300)).toBe(false);
    });
});
