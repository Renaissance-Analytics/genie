import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseProxyAnswer, routeLabel } from '../src/core/proxy-answer.js';
import { GEN_CA_SUBJECT } from '../src/core/gen-ca.js';
import { memoryPair } from '../src/core/line-transport.js';
import { hostHttpsFetch } from '../src/main/host-https-fetch.js';
import { hostTynnPorts } from '../src/main/host-tynn-account.js';
import { ProxyMemory } from '../src/main/proxy-memory.js';
import { reportProxyAnswers } from '../src/main/proxy-report.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { TynnAccount, unreachableThroughMessage } from '../src/main/tynn-account.js';
import { issueCa, issueLeaf, type IssuedPem } from '../src/main/x509.js';
import { fakeKeychain, plainCredentialStore } from './helpers/tynn-storage.js';

/**
 * THE OS'S PROXY, FOR THE HOST (P3.4 cut c; the owner, 2026-11-02: "Yes, cover it."). A window's fetch goes where the OS says; Node knows
 * nothing of it. So a window asks `session.resolveProxy()` and hands the answer over, and the host remembers it for when no window is
 * open. Explicit HTTPS_PROXY / NO_PROXY win, then the remembered answer, then direct. A dead proxy is "Tynn unreachable through <that
 * proxy>": never signed out, and never a silent trip around the proxy.
 *
 * Real sockets: a request either goes through the proxy or it does not. Node's own proxy agent arrived in 24, and CI's unit job runs 22, so
 * the routed cases also run under Electron's Node in scripts/perf-lag/host-tls-measure.mjs.
 */

const DAY = 86_400_000;
const NOW = Date.now();
const CA = issueCa({ commonName: GEN_CA_SUBJECT.commonName, organization: GEN_CA_SUBJECT.organization, notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 30 * DAY) });
const STRANGER = issueCa({ commonName: 'Nobody You Know', organization: 'Nobody', notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 30 * DAY) });
const trusted = (): readonly string[] => [CA.certPem];
const GET = { method: 'GET' as const, headers: {}, credentials: 'omit' as const, redirect: 'error' as const, signal: new AbortController().signal };
const routed = Number(process.versions.node.split('.')[0]) >= 24;

let dir: string;
const open: Array<HttpServer | HttpsServer> = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'host-proxy-')); });
afterEach(async () => {
    for (const server of open.splice(0)) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    rmSync(dir, { recursive: true, force: true });
});

async function tls(ca: IssuedPem = CA): Promise<string> {
    const leaf = issueLeaf(ca, ['localhost'], new Date(NOW - DAY), new Date(NOW + 30 * DAY));
    const server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => res.end('{"ok":true}'));
    open.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `https://localhost:${(server.address() as AddressInfo).port}/`;
}
async function proxy(answer: 'tunnel' | 407 = 'tunnel') {
    const tunnels: string[] = [];
    const server = createHttpServer();
    server.on('connect', (req, client, head) => {
        tunnels.push(req.url ?? '');
        if (answer !== 'tunnel') { client.end(`HTTP/1.1 ${answer} Proxy Authentication Required\r\n\r\n`); return; }
        const [host, port] = (req.url ?? '').split(':');
        const up = netConnect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => { client.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(client); client.pipe(up); });
        up.on('error', () => client.destroy());
        client.on('error', () => up.destroy());
    });
    open.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as AddressInfo).port, tunnels };
}
/** A port nothing listens on: bound, read and closed. */
async function deadPort(): Promise<number> {
    const server = createHttpServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    await new Promise((r) => server.close(r));
    return port;
}
const answering = (answer: string) => (): ReturnType<typeof parseProxyAnswer> => parseProxyAnswer(answer);

describe('what session.resolveProxy() answers', () => {
    it('DIRECT, and nothing at all, are direct', () => {
        expect(parseProxyAnswer('DIRECT')).toEqual([{ kind: 'direct' }]);
        expect(parseProxyAnswer('')).toEqual([{ kind: 'direct' }]);
    });

    it('`PROXY a:1; DIRECT`: both, in the order given', () => {
        expect(parseProxyAnswer('PROXY a:1; DIRECT')).toEqual([{ kind: 'proxy', scheme: 'http', host: 'a', port: 1 }, { kind: 'direct' }]);
    });

    it('several proxies, spacing and case as they come', () => {
        expect(parseProxyAnswer(' proxy a.example:8080 ;HTTPS b.example:443;  PROXY c:3128')).toEqual([
            { kind: 'proxy', scheme: 'http', host: 'a.example', port: 8080 },
            { kind: 'proxy', scheme: 'https', host: 'b.example', port: 443 },
            { kind: 'proxy', scheme: 'http', host: 'c', port: 3128 },
        ]);
    });

    it('an IPv6 proxy keeps its brackets', () => {
        expect(parseProxyAnswer('PROXY [::1]:8080')).toEqual([{ kind: 'proxy', scheme: 'http', host: '[::1]', port: 8080 }]);
    });

    it('SOCKS is named and marked: Node cannot speak it', () => {
        expect(parseProxyAnswer('SOCKS5 s:1080; DIRECT')).toEqual([{ kind: 'unsupported', scheme: 'socks5', host: 's', port: 1080 }, { kind: 'direct' }]);
    });

    it('a PAC script’s answer is the same string, taken as it was resolved at that moment', () => {
        // Chromium runs the script; what comes back is this format. There is no script here to run again.
        expect(parseProxyAnswer('PROXY from-pac.example:3128; DIRECT')[0]).toMatchObject({ host: 'from-pac.example' });
    });

    it('CREDENTIALS NEVER SURVIVE: a user and password in an answer are dropped', () => {
        const routes = parseProxyAnswer('PROXY alice:s3cret@a.example:8080');
        expect(routes).toEqual([{ kind: 'proxy', scheme: 'http', host: 'a.example', port: 8080 }]);
        expect(JSON.stringify(routes)).not.toContain('s3cret');
    });

    it('nonsense is not a route, and a port out of range is not a port', () => {
        expect(parseProxyAnswer('PROXY nonsense; DIRECT')).toEqual([{ kind: 'direct' }]);
        expect(parseProxyAnswer('PROXY a:70000; DIRECT')).toEqual([{ kind: 'direct' }]);
        expect(parseProxyAnswer('WHAT a:1; DIRECT')).toEqual([{ kind: 'direct' }]);
    });

    it('all nonsense is NOT silently direct: an answer naming a proxy that could not be read says so', () => {
        expect(parseProxyAnswer('PROXY nonsense')).toEqual([{ kind: 'unsupported', scheme: 'unreadable', host: 'PROXY nonsense', port: 0 }]);
    });

    it('a label for a person, with no scheme games', () => {
        expect(routeLabel({ kind: 'proxy', scheme: 'http', host: 'a', port: 1 })).toBe('a:1');
    });
});

describe('the host remembers it', () => {
    const file = () => join(dir, 'host-proxy.json');

    it('a new host reads what the last window said: a start with no window uses it', async () => {
        const memory = await ProxyMemory.open(file());
        await memory.remember({ 'https://tynn.ai': 'PROXY a:1; DIRECT' });
        const later = await ProxyMemory.open(file());
        expect(later.routesFor('https://tynn.ai/api/v1/me')).toEqual([{ kind: 'proxy', scheme: 'http', host: 'a', port: 1 }, { kind: 'direct' }]);
    });

    it('a host it was never told about is direct; no answer yet is direct', async () => {
        const memory = await ProxyMemory.open(file());
        expect(memory.routesFor('https://tynn.ai/')).toEqual([{ kind: 'direct' }]);
        await memory.remember({ 'https://tynn.ai': 'PROXY a:1' });
        expect(memory.routesFor('https://elsewhere.example/')).toEqual([{ kind: 'direct' }]);
    });

    it('a fresh answer replaces the old one, and DIRECT is an answer', async () => {
        const memory = await ProxyMemory.open(file());
        await memory.remember({ 'https://tynn.ai': 'PROXY a:1' });
        await memory.remember({ 'https://tynn.ai': 'DIRECT' });
        expect((await ProxyMemory.open(file())).routesFor('https://tynn.ai/')).toEqual([{ kind: 'direct' }]);
    });

    it('CREDENTIALS NEVER REACH THE FILE, and the proxy still does', async () => {
        const memory = await ProxyMemory.open(file());
        await memory.remember({ 'https://tynn.ai': 'PROXY alice:s3cret@a.example:8080' });
        expect(readFileSync(file(), 'utf8')).not.toMatch(/s3cret|alice/);
        expect(readFileSync(file(), 'utf8')).toContain('a.example:8080');
    });

    it.skipIf(process.platform === 'win32')('the file is the owner’s alone, and one left wider is tightened', async () => {
        const memory = await ProxyMemory.open(file());
        await memory.remember({ 'https://tynn.ai': 'PROXY a:1' });
        expect(statSync(file()).mode & 0o777).toBe(0o600);
        const wider = join(dir, 'wider.json');
        writeFileSync(wider, JSON.stringify({ version: 1, origins: {} }), { mode: 0o644 });
        await ProxyMemory.open(wider);
        expect(statSync(wider).mode & 0o777).toBe(0o600);
    });

    it('a file that cannot be understood is direct, and said', async () => {
        writeFileSync(file(), '{ not json');
        const lines: string[] = [];
        const memory = await ProxyMemory.open(file(), (line) => lines.push(line));
        expect(memory.routesFor('https://tynn.ai/')).toEqual([{ kind: 'direct' }]);
        expect(lines.join()).toMatch(/proxy/i);
    });

    it('only an https origin with a string answer is kept', async () => {
        const memory = await ProxyMemory.open(file());
        await memory.remember({ 'http://plain.example': 'PROXY a:1', 'https://ok.example/with/a/path': 'PROXY b:2', 'https://number.example': 7 as never });
        expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8')).origins)).toEqual([]);
    });
});

describe.runIf(routed)('the host goes where the answer says', () => {
    it('a request goes through the proxy the OS answer names', async () => {
        const p = await proxy();
        const url = await tls();
        const res = await hostHttpsFetch({ machineRoots: trusted, env: {}, proxyRoutes: answering(`PROXY 127.0.0.1:${p.port}`) })(url, GET);
        expect(res.status).toBe(200);
        expect(p.tunnels).toHaveLength(1);
    });

    it('CONTROL: the same request with a DIRECT answer does not touch the proxy', async () => {
        const p = await proxy();
        const url = await tls();
        const res = await hostHttpsFetch({ machineRoots: trusted, env: {}, proxyRoutes: answering('DIRECT') })(url, GET);
        expect(res.status).toBe(200);
        expect(p.tunnels).toEqual([]);
    });

    it('through it, an unknown CA is still refused, and DIRECT in the answer does not rescue that', async () => {
        const p = await proxy();
        const url = await tls(STRANGER);
        await expect(hostHttpsFetch({ machineRoots: trusted, env: {}, proxyRoutes: answering(`PROXY 127.0.0.1:${p.port}; DIRECT`) })(url, GET)).rejects.toThrow();
        expect(p.tunnels).toHaveLength(1);
    });

    describe('precedence', () => {
        it('an explicit HTTPS_PROXY wins over the remembered answer', async () => {
            const explicit = await proxy();
            const remembered = await proxy();
            const url = await tls();
            await hostHttpsFetch({ machineRoots: trusted, env: { HTTPS_PROXY: `http://127.0.0.1:${explicit.port}` }, proxyRoutes: answering(`PROXY 127.0.0.1:${remembered.port}`) })(url, GET);
            expect(explicit.tunnels).toHaveLength(1);
            expect(remembered.tunnels).toEqual([]);
        });

        it('an explicit NO_PROXY keeps a host off the remembered proxy too', async () => {
            const remembered = await proxy();
            const url = await tls();
            await hostHttpsFetch({ machineRoots: trusted, env: { NO_PROXY: 'localhost' }, proxyRoutes: answering(`PROXY 127.0.0.1:${remembered.port}`) })(url, GET);
            expect(remembered.tunnels).toEqual([]);
        });

        it('NO_PROXY for another host leaves the remembered proxy in force', async () => {
            const remembered = await proxy();
            const url = await tls();
            await hostHttpsFetch({ machineRoots: trusted, env: { NO_PROXY: 'elsewhere.example' }, proxyRoutes: answering(`PROXY 127.0.0.1:${remembered.port}`) })(url, GET);
            expect(remembered.tunnels).toHaveLength(1);
        });
    });

    describe('a dead proxy', () => {
        it('is an error NAMING IT, with no trip around it', async () => {
            let reached = 0;
            const leaf = issueLeaf(CA, ['localhost'], new Date(NOW - DAY), new Date(NOW + 30 * DAY));
            const server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => { reached += 1; res.end('{}'); });
            open.push(server);
            await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
            const dead = await deadPort();
            const asked = hostHttpsFetch({ machineRoots: trusted, env: {}, proxyRoutes: answering(`PROXY 127.0.0.1:${dead}`) })(`https://localhost:${(server.address() as AddressInfo).port}/`, GET);
            await expect(asked).rejects.toMatchObject({ proxy: `127.0.0.1:${dead}`, message: expect.stringContaining(`127.0.0.1:${dead}`) });
            expect(reached).toBe(0);
        });

        it('`PROXY dead; DIRECT`: the answer itself allows it, so direct is tried, and it is SAID', async () => {
            const dead = await deadPort();
            const url = await tls();
            const said: string[] = [];
            const res = await hostHttpsFetch({ machineRoots: trusted, env: {}, proxyRoutes: answering(`PROXY 127.0.0.1:${dead}; DIRECT`), log: (line) => said.push(line) })(url, GET);
            expect(res.status).toBe(200);
            expect(said.join()).toContain(`127.0.0.1:${dead}`);
            expect(said.join()).toMatch(/direct/i);
        });

        it('a second proxy in the answer is tried before giving up', async () => {
            const dead = await deadPort();
            const alive = await proxy();
            const url = await tls();
            const res = await hostHttpsFetch({ machineRoots: trusted, env: {}, proxyRoutes: answering(`PROXY 127.0.0.1:${dead}; PROXY 127.0.0.1:${alive.port}`) })(url, GET);
            expect(res.status).toBe(200);
            expect(alive.tunnels).toHaveLength(1);
        });

        it('a proxy that asks for a sign-in names it and says so: the host has no prompt to answer with', async () => {
            const p = await proxy(407);
            const url = await tls();
            await expect(hostHttpsFetch({ machineRoots: trusted, env: {}, proxyRoutes: answering(`PROXY 127.0.0.1:${p.port}`) })(url, GET))
                .rejects.toMatchObject({ proxy: `127.0.0.1:${p.port}`, message: expect.stringMatching(/sign-in|407/i) });
        });
    });
});

describe('a SOCKS answer', () => {
    it('is refused by name, not sent direct', async () => {
        const url = await tls();
        await expect(hostHttpsFetch({ machineRoots: trusted, env: {}, proxyRoutes: answering('SOCKS5 s.example:1080') })(url, GET))
            .rejects.toMatchObject({ proxy: 's.example:1080', message: expect.stringMatching(/SOCKS/i) });
    });

    it('with DIRECT after it, direct is tried, and it is said', async () => {
        const url = await tls();
        const said: string[] = [];
        const res = await hostHttpsFetch({ machineRoots: trusted, env: {}, proxyRoutes: answering('SOCKS5 s.example:1080; DIRECT'), log: (line) => said.push(line) })(url, GET);
        expect(res.status).toBe(200);
        expect(said.join()).toContain('s.example:1080');
    });
});

describe.runIf(routed)('the account, with a dead proxy', () => {
    const TOKEN = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'ab'.repeat(32)}`;
    const SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];

    it('IS UNREACHABLE THROUGH THAT PROXY, NOT SIGNED OUT: the credential and the record stay, and it comes back', async () => {
        const dead = await deadPort();
        const leaf = issueLeaf(CA, ['localhost'], new Date(NOW - DAY), new Date(NOW + 30 * DAY));
        const server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => { res.writeHead(200); res.end(JSON.stringify({ id: 'user-7', name: 'W', email: 'w@example.invalid' })); });
        open.push(server);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const host = `https://localhost:${(server.address() as AddressInfo).port}`;
        const file = join(dir, 'tynn.json');
        writeFileSync(file, JSON.stringify({ version: 1, state: 'signed-in', host, userId: 'user-7', scopes: SCOPES }));
        const before = readFileSync(file, 'utf8');
        const secrets = fakeKeychain({ 'tynn/pairing': TOKEN });
        let routes = `PROXY 127.0.0.1:${dead}`;
        const account = await TynnAccount.open({
            ...hostTynnPorts({ file, host: () => host, secrets, machineRoots: trusted, env: {}, proxyRoutes: () => parseProxyAnswer(routes) }),
            credentials: plainCredentialStore,
        });
        expect(account.unreachableThrough()).toBe(`127.0.0.1:${dead}`);
        expect(account.status().signedIn).toBe(false);
        expect(account.savedUserId()).toBe('user-7');
        expect(readFileSync(file, 'utf8')).toBe(before);
        expect(secrets.held.get('tynn/pairing')).toBe(TOKEN);
        await expect(account.recheck()).resolves.toBeDefined();
        // The proxy is fixed, or the OS says direct now.
        routes = 'DIRECT';
        await account.recheck();
        expect(account.status().signedIn).toBe(true);
        expect(account.unreachableThrough()).toBeNull();
    });
});

describe('the window hands the answer over', () => {
    it('it asks for each host and sends what the OS said', async () => {
        const asked: string[] = [];
        const sent: unknown[] = [];
        await reportProxyAnswers({
            hosts: ['https://tynn.ai', 'https://github.com'],
            resolve: async (url) => { asked.push(url); return url.includes('tynn') ? 'PROXY a:1; DIRECT' : 'DIRECT'; },
            send: async (answers) => { sent.push(answers); },
        });
        expect(asked).toEqual(['https://tynn.ai', 'https://github.com']);
        expect(sent).toEqual([{ 'https://tynn.ai': 'PROXY a:1; DIRECT', 'https://github.com': 'DIRECT' }]);
    });

    it('a host it could not resolve keeps its last answer: left out, never sent as direct', async () => {
        const sent: unknown[] = [];
        await reportProxyAnswers({
            hosts: ['https://tynn.ai', 'https://github.com'],
            resolve: async (url) => { if (url.includes('github')) throw new Error('no'); return 'PROXY a:1'; },
            send: async (answers) => { sent.push(answers); },
        });
        expect(sent).toEqual([{ 'https://tynn.ai': 'PROXY a:1' }]);
    });

    it('a failure to send is said, not thrown', async () => {
        const lines: string[] = [];
        await reportProxyAnswers({ hosts: ['https://tynn.ai'], resolve: async () => 'DIRECT', send: async () => { throw new Error('the link is down'); }, log: (line) => lines.push(line) });
        expect(lines.join()).toMatch(/proxy/i);
    });

    it('over the link: the host remembers it, and a window can only write it', async () => {
        const file = join(dir, 'host-proxy.json');
        const memory = await ProxyMemory.open(file);
        let changed = 0;
        const server = new SessionEngineServer({ token: 'a'.repeat(64), build: 'test', proxy: { remember: async (a: Record<string, string>) => { await memory.remember(a); changed += 1; } } });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, 'a'.repeat(64));
        const reply = await client.call('engine.proxyRemember', [{ 'https://tynn.ai': 'PROXY a:1' }]);
        expect(reply.ok).toBe(true);
        expect(changed).toBe(1);
        expect(memory.routesFor('https://tynn.ai/')).toEqual([{ kind: 'proxy', scheme: 'http', host: 'a', port: 1 }]);
    });
});

describe('where it is wired', () => {
    const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

    it('Settings says which proxy, and that the sign-in stands', () => {
        expect(unreachableThroughMessage('a.example:8080')).toMatch(/a\.example:8080[\s\S]*sign-in is kept/);
        expect(strip(readFileSync('src/main/feature-ipc.ts', 'utf8'))).toMatch(/through \? unreachableThroughMessage\(through\)/);
    });

    it('main asks at each connect and at wake, and genie-host uses what it remembers', () => {
        const main = strip(readFileSync('src/main/main.ts', 'utf8'));
        expect(main).toMatch(/reportProxyAnswers\(/);
        expect(main).toMatch(/\.resolveProxy\(/);
        const host = strip(readFileSync('src/main/genie-host.ts', 'utf8'));
        expect(host).toMatch(/ProxyMemory\.open\(/);
        expect(host).toMatch(/proxyRoutes:/);
    });
});
