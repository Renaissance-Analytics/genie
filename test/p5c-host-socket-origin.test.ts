import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * P5c: GENIE-HOST'S TYNN SOCKET SAYS THE ORIGIN TYNN REQUIRES. Production's Reverb answers only `Origin: https://tynn.ai`
 * (genie#1478); anything else, or none, is `pusher:error` 4009 and then silence. src/main/tynn-socket.ts passes the header
 * through a non-standard constructor argument of the runtime's own WebSocket. In the window that was Electron main's; the
 * host runs on the same binary as plain Node (`ELECTRON_RUN_AS_NODE=1`), a different global. A runtime that dropped the
 * header would look like a silent refusal, so this runs the host's own module, unchanged but for its types, under that
 * binary in that mode, against a local server that records the handshake's headers as they arrived on the wire.
 */
const ORIGIN = 'https://tynn.ai';

let dirs: string[] = [];
afterEach(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); dirs = []; });

describe('genie-host’s Tynn socket under ELECTRON_RUN_AS_NODE', () => {
    it('puts the Tynn host’s Origin on the wire and is answered; CONTROL: a dial without it is seen with none, and refused', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'p5c-origin-'));
        dirs.push(dir);
        // The module genie-host dials with, built as genie-host's bundle is (esbuild, node, ESM).
        buildSync({ entryPoints: [resolve('src/main/tynn-socket.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'tynn-socket.mjs'), logLevel: 'silent' });
        const fake = pathToFileURL(resolve('scripts/perf-lag/fake-reverb.mjs')).href;
        await writeFile(join(dir, 'run.mjs'), `
import { startFakeReverb } from ${JSON.stringify(fake)};
import { dialTynnSocket } from './tynn-socket.mjs';
const first = (socket) => new Promise((done) => {
    const timer = setTimeout(() => done({ silent: true }), 10000);
    const end = (r) => { clearTimeout(timer); try { socket.close(); } catch {} done(r); };
    socket.addEventListener('message', (e) => end({ frame: String(e.data) }));
    socket.addEventListener('error', (e) => end({ error: String(e.message ?? 'error') }));
    socket.addEventListener('close', () => end({ closed: true }));
});
const reverb = await startFakeReverb({ allowedOrigins: [${JSON.stringify(ORIGIN)}] });
const bare = await first(new WebSocket(reverb.url()));
const host = await first(dialTynnSocket(reverb.url(), ${JSON.stringify(`${ORIGIN}/`)}));
console.log(JSON.stringify({ electron: process.versions.electron ?? null, asNode: process.env.ELECTRON_RUN_AS_NODE ?? null, wire: reverb.connections.map((c) => c.origin), bare, host }));
await reverb.close();
process.exit(0);
`);
        const electron = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/electron/dist/electron');
        const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
            const p = spawn(electron, [join(dir, 'run.mjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
            let stdout = '';
            let stderr = '';
            p.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
            p.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
            p.on('error', fail);
            p.on('exit', (code) => { done({ code, stdout, stderr }); });
        });
        const said = `${out.stdout}\n${out.stderr}`;
        const result = JSON.parse(out.stdout.trim().split('\n').at(-1) ?? '{}') as { electron: string | null; asNode: string | null; wire: Array<string | null>; bare: { frame?: string }; host: { frame?: string } };
        // The runtime is Electron's binary, as plain Node: genie-host's.
        expect(result.electron, said).toMatch(/^\d+\./);
        expect(result.asNode).toBe('1');
        // CONTROL: the gauge reads an absent header as absent, and the server refuses it.
        expect(result.wire[0], said).toBeNull();
        expect(result.bare.frame ?? '', said).toMatch(/4009/);
        // The host's socket: the Origin on the wire, exactly, and the server's welcome — not a silent refusal.
        expect(result.wire[1], `the Origin as it arrived on the wire\n${said}`).toBe(ORIGIN);
        expect(result.host.frame ?? '', said).toMatch(/pusher:connection_established/);
        expect(out.code).toBe(0);
    }, 60_000);
});
