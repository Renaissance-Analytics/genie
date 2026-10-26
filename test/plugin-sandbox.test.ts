import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureNetGuard, subprocessCommand } from '../src/main/plugin-runner.js';

/**
 * A PLUGIN TOOL GETS ONLY WHAT ITS MANIFEST DECLARES (genie#871, the sandbox half). A plugin tool ran as plain Node with
 * every builtin: its declared `fs` and `network` were words, not limits. Now it runs under Node's permission model
 * (`--permission`): it reads its own folder, and the workspace only when it declares `fs` (then it may write there too);
 * no child process, no worker, no native addon, no `process.binding`. The network — which the permission model does not
 * cover in this Node — goes through a guard loaded before the plugin (`--import`): only the declared hosts, no UDP.
 *
 * Measured first (2026-10-26, omarchy-test): `--permission` denies reads outside, child_process and process.binding under
 * BOTH plain Node 22.23 and Electron 45 as Node (24.22); neither has `--allow-net`; the guard denied net, http, fetch and
 * tls with no host declared and allowed them with the host declared. These tests run the real thing: real processes,
 * under the runtime running the tests and — when its binary is present — Electron as Node, which is what Genie ships.
 */

const ELECTRON = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/electron/dist/electron');
const RUNTIMES: { name: string; execPath: string; electron: boolean }[] = [
    { name: 'node', execPath: process.execPath, electron: false },
    ...(existsSync(ELECTRON) ? [{ name: 'electron-as-node', execPath: ELECTRON, electron: true }] : []),
];

let dir: string;
let pluginDir: string;
let workspace: string;
let elsewhere: string;
let guardDir: string;
let server: Server;
let port: number;

/** What a plugin tries, each reported — the probe a sandbox test needs (an attempt that throws is a result, not a crash). */
const PROBE = `
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import dgram from 'node:dgram';
const [ownFile, workspaceFile, outsideFile, port] = process.argv.slice(2);
const out = {};
const sync = (k, fn) => { try { fn(); out[k] = 'ok'; } catch (e) { out[k] = e.code ?? 'error'; } };
const async = (k, fn) => new Promise((res) => { const t = setTimeout(() => { out[k] ??= 'TIMEOUT'; res(); }, 5000); fn().then(() => { out[k] = 'ok'; clearTimeout(t); res(); }, (e) => { out[k] = e?.code ?? e?.cause?.code ?? 'error'; clearTimeout(t); res(); }); });
sync('readOwn', () => readFileSync(ownFile));
sync('readWorkspace', () => readFileSync(workspaceFile));
sync('writeWorkspace', () => writeFileSync(workspaceFile + '.out', 'x'));
sync('readOutside', () => readFileSync(outsideFile));
sync('childProcess', () => { const r = spawnSync(process.execPath, ['-e', '1']); if (r.error) throw r.error; });
sync('binding', () => process.binding('fs'));
sync('udp', () => dgram.createSocket('udp4'));
await async('net', () => new Promise((res, rej) => { const s = net.connect(Number(port), '127.0.0.1'); s.on('connect', () => { s.destroy(); res(); }); s.on('error', rej); }));
await async('http', () => new Promise((res, rej) => http.get('http://127.0.0.1:' + port + '/', (r) => { r.resume(); res(); }).on('error', rej)));
await async('fetch', () => fetch('http://127.0.0.1:' + port + '/').then((r) => r.text()));
await async('webSocket', () => new Promise((res, rej) => { const w = new WebSocket('ws://127.0.0.1:' + port + '/'); w.onopen = () => { w.close(); res(); }; w.onerror = (e) => rej(Object.assign(new Error('ws'), { code: e?.error?.cause?.code ?? e?.error?.code ?? 'WS_ERROR' })); }));
console.log(JSON.stringify(out));
// Kept-alive http/fetch sockets and a WebSocket waiting on its close handshake would hold the process open (gate run 1).
process.exit(0);
`;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-plugin-sandbox-'));
    pluginDir = join(dir, 'plugins', 'acme.probe');
    workspace = join(dir, 'workspace');
    elsewhere = join(dir, 'elsewhere');
    guardDir = join(dir, 'genie-home', 'plugin-sandbox');
    for (const d of [pluginDir, workspace, elsewhere]) await import('node:fs/promises').then((fs) => fs.mkdir(d, { recursive: true }));
    await writeFile(join(pluginDir, 'probe.mjs'), PROBE);
    await writeFile(join(pluginDir, 'own.txt'), 'mine');
    await writeFile(join(workspace, 'notes.md'), 'notes');
    await writeFile(join(elsewhere, 'secret.txt'), 'secret');
    // A server that answers HTTP AND completes a WebSocket handshake, so a refused connection is the sandbox's doing.
    server = createServer((_q, r) => r.end('ok'));
    // The probe exits as soon as it has reported; on Windows the sockets it leaves are RESET, not closed. That is the
    // probe ending, not a failure: said nowhere (Windows test VM run 1: two uncaught ECONNRESET after 16/16 passed).
    server.on('connection', (socket) => socket.on('error', () => {}));
    server.on('upgrade', (req, socket) => {
        socket.on('error', () => {});
        const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
});
afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
});

function probe(runtime: (typeof RUNTIMES)[number], sandbox: { workspace: string | null; hosts: string[] }): Promise<Record<string, string>> {
    const guard = ensureNetGuard(guardDir);
    const cmd = subprocessCommand(
        { module: join(pluginDir, 'probe.mjs'), process: 'subprocess', env: { PATH: process.env.PATH ?? '' }, sandbox: { pluginDir, workspace: sandbox.workspace, hosts: sandbox.hosts } },
        { execPath: runtime.execPath, electron: runtime.electron, netGuard: guard },
    );
    return new Promise((done, fail) => {
        const p = spawn(cmd.file, [...cmd.args, join(pluginDir, 'own.txt'), join(workspace, 'notes.md'), join(elsewhere, 'secret.txt'), String(port)], { env: cmd.env });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('exit', () => {
            try { done(JSON.parse(out.trim().split('\n').pop()!)); } catch { fail(new Error(`no report from the probe: ${err.slice(0, 500)}`)); }
        });
    });
}

describe.each(RUNTIMES)('a plugin tool, sandboxed — $name', (runtime) => {
    it('with nothing declared: its own folder only — no workspace, nothing outside, no child process, no binding, no network', async () => {
        const r = await probe(runtime, { workspace: null, hosts: [] });
        expect(r.readOwn).toBe('ok');
        expect(r).toMatchObject({ readWorkspace: 'ERR_ACCESS_DENIED', writeWorkspace: 'ERR_ACCESS_DENIED', readOutside: 'ERR_ACCESS_DENIED', childProcess: 'ERR_ACCESS_DENIED', binding: 'ERR_ACCESS_DENIED' });
        expect(r).toMatchObject({ net: 'ERR_GENIE_NETWORK_DENIED', http: 'ERR_GENIE_NETWORK_DENIED', fetch: 'ERR_GENIE_NETWORK_DENIED', udp: 'ERR_GENIE_NETWORK_DENIED' });
        expect(r.webSocket).not.toBe('ok');
    }, 30_000);

    it('fs declared: the workspace, read and write — still nothing outside it', async () => {
        const r = await probe(runtime, { workspace, hosts: [] });
        expect(r).toMatchObject({ readOwn: 'ok', readWorkspace: 'ok', writeWorkspace: 'ok', readOutside: 'ERR_ACCESS_DENIED' });
        expect(await readFile(join(workspace, 'notes.md.out'), 'utf8')).toBe('x');
    }, 30_000);

    it('a declared host: every TCP route reaches it — the CONTROL that proves the denials above are the guard\'s; UDP stays off', async () => {
        const r = await probe(runtime, { workspace: null, hosts: ['127.0.0.1'] });
        expect(r).toMatchObject({ net: 'ok', http: 'ok', fetch: 'ok', webSocket: 'ok', udp: 'ERR_GENIE_NETWORK_DENIED' });
    }, 30_000);
});

describe('the command Genie runs a plugin tool with', () => {
    const spec = { module: join('/', 'p', 'tool.mjs'), process: 'subprocess' as const, env: { PATH: '/bin' }, sandbox: { pluginDir: join('/', 'p'), workspace: null, hosts: ['api.example.com'] } };

    it('is sandboxed, with the guard first and the hosts in the env; under Electron it runs as Node', () => {
        const cmd = subprocessCommand(spec, { execPath: '/genie', electron: true, netGuard: join('/', 'g', 'net-guard.mjs') });
        expect(cmd.args[0]).toBe('--permission');
        expect(cmd.args).toContain(`--allow-fs-read=${join('/', 'p')}`);
        expect(cmd.args.some((a) => a.startsWith('--import=file:'))).toBe(true);
        expect(cmd.args.at(-1)).toBe(spec.module);
        expect(cmd.args.some((a) => a.startsWith('--allow-fs-write') || a.startsWith('--allow-child-process') || a.startsWith('--allow-worker') || a.startsWith('--allow-addons'))).toBe(false);
        expect(cmd.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', GENIE_PLUGIN_HOSTS: 'api.example.com', PATH: '/bin' });
    });

    it('the guard file is written once, by its content, and is the same file next time', () => {
        const a = ensureNetGuard(guardDir);
        const b = ensureNetGuard(guardDir);
        expect(a).toBe(b);
        expect(existsSync(a)).toBe(true);
    });
});
