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
import { execFileSync, spawnSync } from 'node:child_process';
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
            stdin: { contents: "export { hostHttpsFetch } from './src/main/host-https-fetch.ts'; export { issueCa, issueLeaf } from './src/main/x509.ts';", resolveDir: join(here, '..', '..'), loader: 'ts' },
            bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent',
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

const failures = [];
const line = (name, verdict, detail = '') => console.log(`### host-tls ${name}=${verdict}${detail ? `  ${detail}` : ''}`);
const check = (name, ok, detail = '') => { line(name, ok ? 'PASS' : 'FAIL', detail); if (!ok) failures.push(name); };
const errorOf = (error) => { const cause = error?.cause ?? error; return `${cause?.code ?? ''} ${cause?.message ?? String(error)}`.trim(); };

const { hostHttpsFetch, issueCa, issueLeaf } = await import(process.env.HOST_TLS_CHILD);
const dir = process.env.HOST_TLS_DIR;
const NOW = Date.now();
const notBefore = new Date(NOW - 86_400_000);
const notAfter = new Date(NOW + 30 * 86_400_000);
const genieCa = issueCa({ commonName: 'Genie Local Development CA', organization: 'Genie', notBefore, notAfter });
const stranger = issueCa({ commonName: 'Nobody You Know', organization: 'Nobody', notBefore, notAfter });
const caFile = join(dir, 'ca.crt');
writeFileSync(caFile, genieCa.certPem);
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
    const res = await hostHttpsFetch({ genieCaFile: caFile, env: {} })(good.url, GET).then((r) => r.status, (error) => errorOf(error));
    check('genies-ca-answers', res === 200, String(res));
    const refused = await hostHttpsFetch({ genieCaFile: caFile, env: {} })(bad.url, GET).then((r) => `answered ${r.status}`, (error) => errorOf(error));
    check('an-unknown-ca-is-refused', !refused.startsWith('answered'), refused);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const forced = await hostHttpsFetch({ genieCaFile: caFile, env: {} })(bad.url, GET).then((r) => `answered ${r.status}`, (error) => errorOf(error));
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
    const via = await hostHttpsFetch({ genieCaFile: caFile, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` } })(good.url, GET).then((r) => r.status, (error) => errorOf(error));
    check('https-proxy-tunnels', via === 200 && tunnels.length === 1, `${via}, ${tunnels.length} tunnel(s)`);
    const viaBad = await hostHttpsFetch({ genieCaFile: caFile, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` } })(bad.url, GET).then((r) => `answered ${r.status}`, (error) => errorOf(error));
    check('through-a-proxy-an-unknown-ca-is-still-refused', !viaBad.startsWith('answered'), viaBad);
    proxy.closeAllConnections(); proxy.close();

    // The public chain, or a test VM's alias, whose CA is only in the OS store.
    const tynn = await hostHttpsFetch({ genieCaFile: caFile, env: process.env })('https://tynn.ai/api/v1/me', { ...GET, signal: AbortSignal.timeout(20_000) }).then((r) => r.status, (error) => errorOf(error));
    const certificate = /CERT|UNABLE_TO|SELF_SIGNED|ALTNAME|verify/i.test(String(tynn));
    if (typeof tynn === 'number') check('tynn-ai-answers-and-the-chain-verifies', tynn === 404 || tynn < 500, `http ${tynn} (no credential: 404 is Tynn's answer)`);
    else if (certificate || process.env.HOST_TLS_TYNN === 'expect-answer') check('tynn-ai-answers-and-the-chain-verifies', false, String(tynn));
    else line('tynn-ai-answers-and-the-chain-verifies', 'INFO', `no network here: ${tynn}`);
} catch (error) {
    check('the-measure-threw', false, errorOf(error));
} finally {
    good.close(); bad.close();
}
console.log(`### host-tls=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
process.exit(failures.length === 0 ? 0 : 1);
