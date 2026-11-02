#!/usr/bin/env node
/**
 * THE HOST'S TLS, MEASURED UNDER ELECTRON'S OWN NODE (host split P3.4 cut c; plan §13). genie-host runs on Electron's binary with
 * ELECTRON_RUN_AS_NODE, and that Node is built on BoringSSL, so a result from plain Node does not carry over.
 *
 *   node scripts/perf-lag/host-tls-measure.mjs            # bundles src/main/host-https-fetch.ts, runs itself under Electron
 *   HOST_TLS_TYNN=expect-answer node ...                  # https://tynn.ai must answer: a test VM's alias, or the real one
 *
 * Prints `### host-tls <check>=PASS|FAIL|INFO  detail`, then `### host-tls=PASS|FAIL`. Exit 0 only when every check passed. It never
 * turns verification off. It writes only to a temp directory and calls https://tynn.ai/api/v1/me with no credential, which Tynn
 * answers with a 404 by its rule. Capped at 120 s.
 *
 * The public chain: a NETWORK failure to tynn.ai is INFO, unless HOST_TLS_TYNN=expect-answer: a CI runner's network is not what this
 * measures. A CERTIFICATE failure is always a FAIL. On a test VM tynn.ai is the alias, and its CA is in the OS store only, so
 * expect-answer there measures whether the host reads the store that CA was put in.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.HOST_TLS_CHILD) {
    const require = createRequire(import.meta.url);
    const dir = mkdtempSync(join(tmpdir(), 'host-tls-'));
    let status = 1;
    try {
        const out = join(dir, 'bundle.mjs');
        require('esbuild').buildSync({
            stdin: { contents: "export { hostHttpsFetch } from './src/main/host-https-fetch.ts'; export { deviceSocket } from './src/main/device-socket.ts'; export { WebSocketServer } from 'ws'; export { issueCa, issueLeaf } from './src/main/x509.ts'; export { parseProxyAnswer } from './src/core/proxy-answer.ts';", resolveDir: join(here, '..', '..'), loader: 'ts' },
            bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent',
            // ws is CommonJS, and an ESM bundle has no require of its own.
            banner: { js: "import { createRequire as hostTlsRequire } from 'node:module'; const require = hostTlsRequire(import.meta.url);" },
        });
        const electron = require('electron');
        const child = spawnSync(electron, [fileURLToPath(import.meta.url)], {
            encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOST_TLS_CHILD: pathToFileURL(out).href, HOST_TLS_DIR: dir },
        });
        process.stdout.write(child.stdout ?? '');
        process.stderr.write(child.stderr ?? '');
        status = child.status ?? 1;
        if (child.status === null) console.log(`### host-tls=FAIL  the Electron child did not finish: ${child.signal ?? child.error?.message ?? 'unknown'}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    process.exit(status);
}

/** The same, for the socket to another machine: did the dial get past the certificate? */
const dialOutcome = (deviceSocket, url) => new Promise((resolve) => {
    const socket = deviceSocket(url);
    const timer = setTimeout(() => resolve('no answer'), 15_000);
    socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('open'); };
    socket.onerror = (ev) => { clearTimeout(timer); resolve(String(ev?.message ?? 'error')); };
});
if (process.env.HOST_TLS_STORE_WSS) {
    const { deviceSocket } = await import(process.env.HOST_TLS_CHILD);
    console.log(`STORE-PROBE ${await dialOutcome(deviceSocket, process.env.HOST_TLS_STORE_WSS)}`);
    process.exit(0);
}

/** THE STORE PROBE: a child whose OS store really holds the test CA, by OpenSSL's own variable. It answers and leaves. */
if (process.env.HOST_TLS_STORE_URL) {
    const { hostHttpsFetch } = await import(process.env.HOST_TLS_CHILD);
    const answer = await hostHttpsFetch({ env: {} })(process.env.HOST_TLS_STORE_URL, { method: 'GET', headers: {}, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000) }).then((r) => String(r.status), (error) => String(error?.cause?.code ?? error?.code ?? error?.message ?? error));
    console.log(`STORE-PROBE ${answer}`);
    process.exit(0);
}

const failures = [];
const line = (name, verdict, detail = '') => console.log(`### host-tls ${name}=${verdict}${detail ? `  ${detail}` : ''}`);
const check = (name, ok, detail = '') => { line(name, ok ? 'PASS' : 'FAIL', detail); if (!ok) failures.push(name); };
const errorOf = (error) => { const cause = error?.cause ?? error; return `${cause?.code ?? ''} ${cause?.message ?? String(error)}`.trim(); };

const { hostHttpsFetch, deviceSocket, WebSocketServer, issueCa, issueLeaf, parseProxyAnswer } = await import(process.env.HOST_TLS_CHILD);
const dir = process.env.HOST_TLS_DIR;
const NOW = Date.now();
const notBefore = new Date(NOW - 86_400_000);
const notAfter = new Date(NOW + 30 * 86_400_000);
const genieCa = issueCa({ commonName: 'Genie Local Development CA', organization: 'Genie', notBefore, notAfter });
const stranger = issueCa({ commonName: 'Nobody You Know', organization: 'Nobody', notBefore, notAfter });
const caFile = join(dir, 'ca.crt');
writeFileSync(caFile, genieCa.certPem);
const inTheStore = () => [genieCa.certPem];
/** The same fetch in a child of this binary, with SSL_CERT_FILE as the OS store. Asynchronous: this process serves the TLS it calls. */
const storeProbe = (url, env, asks = 'HOST_TLS_STORE_URL') => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, ...env, [asks]: url }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', () => { clearTimeout(timer); resolve(out.match(/STORE-PROBE (.*)/)?.[1] ?? `no answer: ${out.slice(0, 200)}`); });
});
const GET = { method: 'GET', headers: {}, credentials: 'omit', redirect: 'error', signal: new AbortController().signal };

async function server(ca) {
    const leaf = issueLeaf(ca, ['localhost'], notBefore, notAfter);
    const s = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => res.end('{"ok":true}'));
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    return { url: `https://localhost:${s.address().port}/`, close: () => { s.closeAllConnections(); s.close(); } };
}

line('electron-node', 'INFO', `node ${process.versions.node} electron ${process.versions.electron ?? 'none'} ssl ${process.versions.boringssl ? `boringssl ${process.versions.boringssl}` : `openssl ${process.versions.openssl}`}`);
check('really-under-electron', typeof process.versions.electron === 'string', process.execPath);
let counts = {};
for (const kind of ['bundled', 'system', 'extra', 'default']) {
    try { counts[kind] = tls.getCACertificates(kind).length; } catch (error) { counts[kind] = `threw ${errorOf(error)}`; }
}
line('ca-counts', 'INFO', JSON.stringify(counts));
check('bundled-roots-are-there', typeof counts.bundled === 'number' && counts.bundled > 50, String(counts.bundled));
check('the-os-store-can-be-read', typeof counts.system === 'number', String(counts.system));

const good = await server(genieCa);
const bad = await server(stranger);
try {
    const before = await fetch(good.url).then(() => 'answered', (error) => errorOf(error));
    check('control-nodes-own-fetch-refuses-genies-ca', before !== 'answered', before);
    const res = await hostHttpsFetch({ machineRoots: inTheStore, env: {} })(good.url, GET).then((r) => r.status, (error) => errorOf(error));
    check('a-trusted-ca-answers', res === 200, String(res));
    const notInStore = await hostHttpsFetch({ env: {} })(good.url, GET).then((r) => `answered ${r.status}`, (error) => errorOf(error));
    check('genies-ca-on-disk-but-not-in-the-store-is-refused', !notInStore.startsWith('answered'), notInStore);
    // THE REAL STORE, with nothing injected: does this binary read it? On Linux OpenSSL's variable names it; Windows has the VM's alias.
    if (process.platform === 'linux') {
        const withIt = await storeProbe(good.url, { SSL_CERT_FILE: caFile });
        check('a-ca-really-in-the-os-store-answers', withIt === '200', withIt);
        const without = await storeProbe(good.url, { SSL_CERT_FILE: join(dir, 'absent.crt') });
        check('control-the-same-child-without-it-is-refused', without !== '200', without);
        // THE SOCKET TO ANOTHER MACHINE: the same set. A root ONLY in the OS store: not bundled, not injected, and NODE_EXTRA_CA_CERTS unset.
        const leaf = issueLeaf(genieCa, ['localhost'], notBefore, notAfter);
        const wssServer = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem });
        const dials = { connections: 0 };
        new WebSocketServer({ server: wssServer }).on('connection', () => { dials.connections += 1; });
        await new Promise((r) => wssServer.listen(0, '127.0.0.1', r));
        const wssUrl = `wss://localhost:${wssServer.address().port}/genie`;
        const noExtra = { NODE_EXTRA_CA_CERTS: '' };
        const wssWith = await storeProbe(wssUrl, { ...noExtra, SSL_CERT_FILE: caFile }, 'HOST_TLS_STORE_WSS');
        check('a-wss-machine-whose-root-is-only-in-the-os-store-connects', wssWith === 'open' && dials.connections === 1, `${wssWith}; ${dials.connections} connection(s)`);
        const wssWithout = await storeProbe(wssUrl, { ...noExtra, SSL_CERT_FILE: join(dir, 'absent.crt') }, 'HOST_TLS_STORE_WSS');
        check('control-the-same-wss-dial-without-that-root-is-refused', wssWithout !== 'open' && dials.connections === 1, `${wssWithout}; ${dials.connections} connection(s)`);
        const wssForced = await storeProbe(wssUrl, { ...noExtra, SSL_CERT_FILE: join(dir, 'absent.crt'), NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'HOST_TLS_STORE_WSS');
        check('and-the-env-variable-turns-nothing-off-for-wss', wssForced !== 'open' && dials.connections === 1, `${wssForced}; ${dials.connections} connection(s)`);
        wssServer.closeAllConnections();
        wssServer.close();
    } else line('a-ca-really-in-the-os-store-answers', 'INFO', 'measured here by HOST_TLS_TYNN=expect-answer with the alias up');
    const refused = await hostHttpsFetch({ machineRoots: inTheStore, env: {} })(bad.url, GET).then((r) => `answered ${r.status}`, (error) => errorOf(error));
    check('an-unknown-ca-is-refused', !refused.startsWith('answered'), refused);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const forced = await hostHttpsFetch({ machineRoots: inTheStore, env: {} })(bad.url, GET).then((r) => `answered ${r.status}`, (error) => errorOf(error));
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    check('the-env-variable-turns-nothing-off', !forced.startsWith('answered'), forced);

    // An env proxy, through a real CONNECT tunnel.
    const tunnels = [];
    const proxy = createHttpServer();
    proxy.on('connect', (req, client, head) => {
        tunnels.push(req.url);
        const [host, port] = req.url.split(':');
        const up = netConnect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => { client.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(client); client.pipe(up); });
        up.on('error', () => client.destroy());
        client.on('error', () => up.destroy());
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const via = await hostHttpsFetch({ machineRoots: inTheStore, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` } })(good.url, GET).then((r) => r.status, (error) => errorOf(error));
    check('https-proxy-tunnels', via === 200 && tunnels.length === 1, `${via}, ${tunnels.length} tunnel(s)`);
    const viaBad = await hostHttpsFetch({ machineRoots: inTheStore, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` } })(bad.url, GET).then((r) => `answered ${r.status}`, (error) => errorOf(error));
    check('through-a-proxy-an-unknown-ca-is-still-refused', !viaBad.startsWith('answered'), viaBad);

    // THE OS'S ANSWER, as a window hands it over (the owner: "Yes, cover it."). Explicit env wins; then this; then direct.
    const proxyPort = proxy.address().port;
    const said = (answer, extra = {}) => hostHttpsFetch({ machineRoots: inTheStore, env: {}, proxyRoutes: () => parseProxyAnswer(answer), ...extra });
    tunnels.length = 0;
    const named = await said(`PROXY 127.0.0.1:${proxyPort}`)(good.url, GET).then((r) => r.status, (error) => errorOf(error));
    check('the-os-answer-goes-through-the-proxy', named === 200 && tunnels.length === 1, `${named}, ${tunnels.length} tunnel(s)`);
    tunnels.length = 0;
    const direct = await said('DIRECT')(good.url, GET).then((r) => r.status, (error) => errorOf(error));
    check('control-a-direct-answer-does-not-touch-it', direct === 200 && tunnels.length === 0, `${direct}, ${tunnels.length} tunnel(s)`);
    const explicitPort = await new Promise((r) => { const other = createHttpServer(); other.on('connect', (_req, client) => client.end('HTTP/1.1 502 No\r\n\r\n')); other.listen(0, '127.0.0.1', () => { const port = other.address().port; other.close(() => r(port)); }); });
    const gone = await said(`PROXY 127.0.0.1:${explicitPort}`)(good.url, GET).then((r) => `answered ${r.status}`, (error) => `${error?.proxy ?? 'no proxy named'}: ${error?.message}`);
    check('a-dead-proxy-is-named-and-nothing-goes-around-it', gone.startsWith(`127.0.0.1:${explicitPort}`), gone);
    const sayings = [];
    const around = await said(`PROXY 127.0.0.1:${explicitPort}; DIRECT`, { log: (l) => sayings.push(l) })(good.url, GET).then((r) => r.status, (error) => errorOf(error));
    check('dead-then-direct-goes-direct-only-as-the-answer-allows-and-says-so', around === 200 && sayings.join().includes(`127.0.0.1:${explicitPort}`), `${around}; ${sayings.join(' ').slice(0, 160)}`);
    tunnels.length = 0;
    const envWins = await hostHttpsFetch({ machineRoots: inTheStore, env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }, proxyRoutes: () => parseProxyAnswer(`PROXY 127.0.0.1:${explicitPort}`) })(good.url, GET).then((r) => r.status, (error) => errorOf(error));
    check('an-explicit-https-proxy-wins-over-the-os-answer', envWins === 200 && tunnels.length === 1, `${envWins}, ${tunnels.length} tunnel(s)`);
    const asks = createHttpServer();
    asks.on('connect', (_req, client) => client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));
    await new Promise((r) => asks.listen(0, '127.0.0.1', r));
    const signIn = await said(`PROXY 127.0.0.1:${asks.address().port}`)(good.url, GET).then((r) => `answered ${r.status}`, (error) => `${error?.proxy ?? 'no proxy named'}: ${error?.message}`);
    check('a-proxy-asking-for-a-sign-in-says-so', signIn.includes('407') && !signIn.startsWith('no proxy'), signIn);
    asks.closeAllConnections(); asks.close();
    proxy.closeAllConnections(); proxy.close();

    // The public chain, or a test VM's alias, whose CA is only in the OS store.
    const tynn = await hostHttpsFetch({ env: process.env })('https://tynn.ai/api/v1/me', { ...GET, signal: AbortSignal.timeout(20_000) }).then((r) => r.status, (error) => errorOf(error));
    const certificate = /CERT|UNABLE_TO|SELF_SIGNED|ALTNAME|verify/i.test(String(tynn));
    if (typeof tynn === 'number') check('tynn-ai-answers-and-the-chain-verifies', tynn === 404 || tynn < 500, `http ${tynn} (no credential: 404 is Tynn's answer)`);
    else if (certificate || process.env.HOST_TLS_TYNN === 'expect-answer') check('tynn-ai-answers-and-the-chain-verifies', false, String(tynn));
    // The wss dial with the REAL store, on either OS: on a test VM tynn.ai is the alias, whose CA is in the OS store only. It need not be a Genie to show the certificate passed:
    // "Unexpected server response" comes after the TLS handshake. A certificate failure comes before it.
    if (process.env.HOST_TLS_TYNN === 'expect-answer') {
        const dialled = await dialOutcome(deviceSocket, 'wss://tynn.ai/genie');
        check('a-wss-dial-to-tynn-ai-passes-the-certificate', dialled === 'open' || /Unexpected server response/.test(dialled), dialled);
    }
    else line('tynn-ai-answers-and-the-chain-verifies', 'INFO', `no network here: ${tynn}`);
} catch (error) {
    check('the-measure-threw', false, errorOf(error));
} finally {
    good.close(); bad.close();
}
console.log(`### host-tls=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
process.exit(failures.length === 0 ? 0 : 1);
