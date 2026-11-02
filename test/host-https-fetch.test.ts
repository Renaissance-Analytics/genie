import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GEN_CA_SUBJECT } from '../src/core/gen-ca.js';
import { hostHttpsFetch } from '../src/main/host-https-fetch.js';
import { hostTynnPorts } from '../src/main/host-tynn-account.js';
import { TynnAccount } from '../src/main/tynn-account.js';
import { issueCa, issueLeaf, type IssuedPem } from '../src/main/x509.js';
import { fakeKeychain, plainCredentialStore } from './helpers/tynn-storage.js';

/**
 * THE HOST'S CALLS TO TYNN, OVER REAL TLS (P3.4 cut c; the coordinator, 2026-11-02: "it can break sign-in outright"). A window's
 * session fetch is Chromium's network stack: the OS certificate store and the OS proxy settings. genie-host has Node. So the host
 * has its own fetch, trusting Node's bundled roots and the OS store, verifying every time, and honouring env proxies. Genie's CA
 * counts only once the person's Trust has put it in the store, as it did for the window.
 *
 * Real sockets on the loopback, no mocks: a certificate either verifies or it does not. `test/host-tls-electron.test.ts` runs the
 * same questions under Electron's own Node, which is built on BoringSSL and is what really runs in the host.
 */

const DAY = 86_400_000;
const NOW = Date.now();
const newCa = (commonName: string): IssuedPem => issueCa({ commonName, organization: GEN_CA_SUBJECT.organization, notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 30 * DAY) });
const leafOf = (ca: IssuedPem): IssuedPem => issueLeaf(ca, ['localhost'], new Date(NOW - DAY), new Date(NOW + 30 * DAY));

const GENIE_CA = newCa(GEN_CA_SUBJECT.commonName);
const STRANGER_CA = newCa('Nobody You Know');

/** What a machine's store holds once the person has pressed Trust. No test touches a real store; the measure does that under Electron. */
const trusted = (): readonly string[] => [GENIE_CA.certPem];

let dir: string;
const open: Array<HttpServer | HttpsServer> = [];
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-https-'));
});
afterEach(async () => {
    for (const server of open.splice(0)) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    rmSync(dir, { recursive: true, force: true });
});

type Handler = Parameters<typeof createHttpsServer>[1];
async function tlsServer(ca: IssuedPem, handler: Handler): Promise<string> {
    const leaf = leafOf(ca);
    const server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, handler);
    open.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `https://localhost:${(server.address() as AddressInfo).port}`;
}
const answers = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (_req, res) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const GET = { method: 'GET' as const, headers: {}, credentials: 'omit' as const, redirect: 'error' as const, signal: new AbortController().signal };

describe('what it trusts', () => {
    it('CONTROL, the failure: Node’s own fetch refuses a server signed by Genie’s CA', async () => {
        const url = await tlsServer(GENIE_CA, answers(200, { ok: true }));
        await expect(globalThis.fetch(`${url}/`)).rejects.toThrow();
    });

    it('a CA in the OS store answers: the person pressed Trust, or a company installed it', async () => {
        const url = await tlsServer(GENIE_CA, answers(200, { hello: 'tynn' }));
        const res = await hostHttpsFetch({ machineRoots: trusted })(`${url}/`, GET);
        expect([res.ok, res.status]).toEqual([true, 200]);
        expect(JSON.parse(await res.text())).toEqual({ hello: 'tynn' });
    });

    it('GENIE’S CA ON DISK BUT NOT IN THE STORE IS REFUSED: no Trust, no trust, and the token is never sent', async () => {
        const home = join(dir, 'runtime', 'gen-ca');
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, 'ca.crt'), GENIE_CA.certPem);
        let bearers = 0;
        const url = await tlsServer(GENIE_CA, (req, res) => { if (req.headers.authorization) bearers += 1; res.end('{}'); });
        await expect(hostHttpsFetch({})(`${url}/`, { ...GET, headers: { Authorization: 'Bearer t' } })).rejects.toThrow();
        expect(bearers).toBe(0);
    });

    it('nothing of the host’s network reads Genie’s CA file', () => {
        const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
        for (const file of ['src/main/host-https-fetch.ts', 'src/main/host-tynn-account.ts', 'src/main/tynn-account-service.ts']) {
            expect(strip(readFileSync(file, 'utf8')), file).not.toMatch(/gen-ca|ca\.crt|genieCa/i);
        }
        expect(strip(readFileSync('src/main/genie-host.ts', 'utf8'))).not.toMatch(/genieCaFile/);
    });

    it('a server signed by a CA nobody knows is REFUSED, and no answer comes back', async () => {
        let reached = 0;
        const url = await tlsServer(STRANGER_CA, (_req, res) => { reached += 1; res.end('secret'); });
        await expect(hostHttpsFetch({ machineRoots: trusted })(`${url}/`, GET)).rejects.toThrow();
        expect(reached).toBe(0);
    });

    it('a certificate for another name is refused, whoever signed it', async () => {
        const leaf = issueLeaf(GENIE_CA, ['elsewhere.example'], new Date(NOW - DAY), new Date(NOW + 30 * DAY));
        const server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, answers(200, {}));
        open.push(server);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        await expect(hostHttpsFetch({ machineRoots: trusted })(`https://localhost:${(server.address() as AddressInfo).port}/`, GET)).rejects.toThrow();
    });

    it('NODE_TLS_REJECT_UNAUTHORIZED=0 in its environment turns nothing off', async () => {
        const url = await tlsServer(STRANGER_CA, answers(200, { leaked: true }));
        const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        try {
            await expect(hostHttpsFetch({ machineRoots: trusted })(`${url}/`, GET)).rejects.toThrow();
        } finally {
            if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
        }
    });
});

describe('it answers as the window’s fetch did', () => {
    it('sends the method, headers and body', async () => {
        let seen: { method?: string; auth?: string; cookie?: string; body?: string } = {};
        const url = await tlsServer(GENIE_CA, (req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => { seen = { method: req.method ?? '', auth: req.headers.authorization ?? '', cookie: req.headers.cookie ?? '', body }; res.end('{}'); });
        });
        await hostHttpsFetch({ machineRoots: trusted })(`${url}/x`, { ...GET, method: 'POST', headers: { Authorization: 'Bearer t', Cookie: 'genie_token=c', 'Content-Type': 'application/json' }, body: '{"a":1}' });
        expect(seen).toEqual({ method: 'POST', auth: 'Bearer t', cookie: 'genie_token=c', body: '{"a":1}' });
    });

    it('a 404 is an answer, not an error', async () => {
        const url = await tlsServer(GENIE_CA, answers(404, { message: 'Not Found' }));
        const res = await hostHttpsFetch({ machineRoots: trusted })(`${url}/`, GET);
        expect([res.ok, res.status]).toEqual([false, 404]);
    });

    it('a redirect is REFUSED (`redirect: error`): a token is never carried to where a server points', async () => {
        const url = await tlsServer(GENIE_CA, answers(302, {}, { Location: 'https://elsewhere.example/' }));
        await expect(hostHttpsFetch({ machineRoots: trusted })(`${url}/`, GET)).rejects.toThrow(/redirect/i);
    });

    it('a call that is cancelled rejects, and one already cancelled never connects', async () => {
        let reached = 0;
        const url = await tlsServer(GENIE_CA, () => { reached += 1; /* never answers */ });
        const send = hostHttpsFetch({ machineRoots: trusted });
        const already = new AbortController();
        already.abort();
        await expect(send(`${url}/`, { ...GET, signal: already.signal })).rejects.toThrow();
        expect(reached).toBe(0);
        const later = new AbortController();
        const asked = send(`${url}/`, { ...GET, signal: later.signal });
        setTimeout(() => later.abort(), 50);
        await expect(asked).rejects.toThrow();
    });

    it('it speaks only https: a plain http URL is refused in its own words, BEFORE any route, and nothing is reached', async () => {
        let reached = 0;
        const plain = createHttpServer((_req, res) => { reached += 1; res.end('{}'); });
        open.push(plain);
        await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
        const url = `http://localhost:${(plain.address() as AddressInfo).port}/`;
        const secret = { ...GET, headers: { Authorization: 'Bearer t' } };
        // Node's own https would refuse this too (ERR_INVALID_PROTOCOL, naming "https:"), so a looser match cannot tell this check is here.
        await expect(hostHttpsFetch({ machineRoots: trusted, env: {} })(url, secret)).rejects.toThrow('The host calls https only');
        // Nor does a remembered route get to say something else first, naming a proxy it would never have used.
        await expect(hostHttpsFetch({ machineRoots: trusted, env: {}, proxyRoutes: () => [{ kind: 'unsupported', scheme: 'socks5', host: 's.example', port: 1080 }] })(url, secret)).rejects.toThrow('The host calls https only');
        expect(reached).toBe(0);
    });
});

describe('env proxies', () => {
    async function connectProxy() {
        const tunnels: string[] = [];
        const proxy = createHttpServer();
        proxy.on('connect', (req, client, head) => {
            tunnels.push(req.url ?? '');
            const [host, port] = (req.url ?? '').split(':');
            const upstream = netConnect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => { client.write('HTTP/1.1 200 OK\r\n\r\n'); upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
            upstream.on('error', () => client.destroy());
            client.on('error', () => upstream.destroy());
        });
        open.push(proxy);
        await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
        return { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, tunnels };
    }
    const proxyEnvWorks = typeof process.features === 'object' && Number(process.versions.node.split('.')[0]) >= 24;

    it.runIf(proxyEnvWorks)('HTTPS_PROXY carries the call through a tunnel, and TLS is still verified end to end', async () => {
        const proxy = await connectProxy();
        const good = await tlsServer(GENIE_CA, answers(200, { through: true }));
        const res = await hostHttpsFetch({ machineRoots: trusted, env: { HTTPS_PROXY: proxy.url } })(`${good}/`, GET);
        expect(res.status).toBe(200);
        expect(proxy.tunnels).toHaveLength(1);
        const bad = await tlsServer(STRANGER_CA, answers(200, {}));
        await expect(hostHttpsFetch({ machineRoots: trusted, env: { HTTPS_PROXY: proxy.url } })(`${bad}/`, GET)).rejects.toThrow();
    });

    it.runIf(proxyEnvWorks)('NO_PROXY keeps a host off it', async () => {
        const proxy = await connectProxy();
        const url = await tlsServer(GENIE_CA, answers(200, {}));
        await hostHttpsFetch({ machineRoots: trusted, env: { HTTPS_PROXY: proxy.url, NO_PROXY: 'localhost' } })(`${url}/`, GET);
        expect(proxy.tunnels).toEqual([]);
    });

    it('no proxy in the environment: direct', async () => {
        const url = await tlsServer(GENIE_CA, answers(200, {}));
        expect((await hostHttpsFetch({ machineRoots: trusted, env: {} })(`${url}/`, GET)).status).toBe(200);
    });
});

describe('the host’s account over it, against a real TLS server', () => {
    const TOKEN = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'ab'.repeat(32)}`;
    const CODE = 'c'.repeat(64);
    const USER = { id: 'user-7', name: 'Wish', email: 'w@example.invalid' };
    const SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];

    async function tynn() {
        const state = { revoked: false };
        const url = await tlsServer(GENIE_CA, (req, res) => {
            const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (req.url === '/api/v1/me' && req.headers.cookie === `genie_token=${CODE}`) return reply(200, { ...USER, pairing_token: TOKEN, pairing_scopes: SCOPES });
            // TYNN ANSWERS EVERY UNAUTHORIZED REQUEST WITH 404 (the owner, 2026-10-26).
            if (req.headers.authorization !== `Bearer ${TOKEN}` || state.revoked) return reply(404, { message: 'Not Found' });
            return reply(200, USER);
        });
        return { url, state };
    }
    const openAccount = (url: string, secrets: ReturnType<typeof fakeKeychain>) => TynnAccount.open({
        ...hostTynnPorts({ file: join(dir, 'tynn.json'), host: () => url, secrets, machineRoots: trusted }),
        credentials: plainCredentialStore,
    });

    it('a real sign-in: the code goes as a cookie over verified TLS and the token lands in the keychain', async () => {
        const { url } = await tynn();
        const secrets = fakeKeychain();
        const account = await openAccount(url, secrets);
        expect(await account.signIn(CODE)).toMatchObject({ ok: true });
        expect(secrets.held.get('tynn/pairing')).toBe(TOKEN);
    });

    it('A 404 FROM TYNN IS SIGNED OUT, AND THE CREDENTIAL IS KEPT: the window’s rule, by the window’s code', async () => {
        const { url, state } = await tynn();
        const secrets = fakeKeychain();
        const account = await openAccount(url, secrets);
        await account.signIn(CODE);
        state.revoked = true;
        await account.recheck();
        expect(account.status().signedIn).toBe(false);
        expect(secrets.held.get('tynn/pairing')).toBe(TOKEN);
        expect(JSON.parse(readFileSync(join(dir, 'tynn.json'), 'utf8')).state).toBe('signed-in');
        expect(account.savedUserId()).toBe(USER.id);
        // It comes back with no new pairing.
        state.revoked = false;
        await account.recheck();
        expect(account.status().signedIn).toBe(true);
    });

    it('a 404 at the launch: signed out, kept, and asked again', async () => {
        const { url, state } = await tynn();
        const secrets = fakeKeychain();
        await (await openAccount(url, secrets)).signIn(CODE);
        state.revoked = true;
        const again = await openAccount(url, secrets);
        expect(again.status().signedIn).toBe(false);
        expect(secrets.held.get('tynn/pairing')).toBe(TOKEN);
    });

    it('a Tynn whose certificate does not verify is unreachable, and the credential is not sent', async () => {
        let bearers = 0;
        const url = await tlsServer(STRANGER_CA, (req, res) => { if (req.headers.authorization) bearers += 1; res.end('{}'); });
        const secrets = fakeKeychain({ 'tynn/pairing': TOKEN });
        writeFileSync(join(dir, 'tynn.json'), JSON.stringify({ version: 1, state: 'signed-in', host: url, userId: USER.id, scopes: SCOPES }));
        const account = await openAccount(url, secrets);
        expect(account.status().signedIn).toBe(false);
        expect(bearers).toBe(0);
        expect(secrets.held.get('tynn/pairing')).toBe(TOKEN);
    });

    it('the host’s account has one 404 rule: it is TynnAccount’s, not a copy', () => {
        const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
        for (const file of ['src/main/host-tynn-account.ts', 'src/main/host-https-fetch.ts', 'src/main/tynn-account-service.ts', 'src/main/tynn-account-replica.ts']) {
            expect(strip(readFileSync(file, 'utf8')), file).not.toMatch(/\b404\b/);
        }
    });
});

describe('verification is never turned off', () => {
    const files = (d: string): string[] => readdirSync(d).flatMap((name) => { const p = join(d, name); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : []; });
    const FORBIDDEN = /rejectUnauthorized\s*:(?!\s*true\b)|NODE_TLS_REJECT_UNAUTHORIZED|ignore-certificate-errors|allow-insecure-localhost/;

    it('no source turns it off: not the option, not the variable, not the switch', () => {
        const found = [...files('src/main'), ...files('src/core')].filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n')));
        expect(found).toEqual([]);
    });

    it('CONTROL: the gauge finds each of them', () => {
        for (const line of ['{ rejectUnauthorized: false }', '{ rejectUnauthorized: strict }', 'env.NODE_TLS_REJECT_UNAUTHORIZED = "0"', "app.commandLine.appendSwitch('ignore-certificate-errors')"]) expect(FORBIDDEN.test(line), line).toBe(true);
        // And it lets through the one way that verifies.
        expect(FORBIDDEN.test('{ rejectUnauthorized: true }')).toBe(false);
    });

    it('it verifies by asking to, explicitly: the environment cannot change an option that is set', () => {
        expect(readFileSync('src/main/host-https-fetch.ts', 'utf8')).toMatch(/rejectUnauthorized: true/);
    });
});
