import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostEndpoint } from '../src/core/engine-protocol.js';

const TSX = import.meta.resolve('tsx');

/**
 * A HOST WHOSE SECRET STORE IS MISCONFIGURED NEVER SERVES (P10.1a, the coordinator's ruling): the file backend is checked
 * before genie-host binds its endpoint, so no window ever connects to a host that is about to exit. The real entry, as its
 * own process, with GENIE_SECRET_BACKEND=file and a key file that is not there.
 *
 * THE ORDER IS PROVED, not inferred from a missing file: the endpoint is held by this test first. A host that bound first
 * finds it taken and leaves saying another host serves (exit 0); a host that checks its secrets first refuses on them
 * (exit 1) and never reaches the endpoint. Runs on CI (spawns a process); never on the owner's desktop.
 */

const homes: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((done) => { s.close(() => done()); });
    for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function runHost(home: string, keyFile: string): Promise<{ code: number | null; log: string }> {
    const child = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], {
        env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'refusal-test', GENIE_SECRET_BACKEND: 'file', GENIE_SECRET_KEY_FILE: keyFile },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout?.on('data', (d) => { log += String(d); });
    child.stderr?.on('data', (d) => { log += String(d); });
    const code = await new Promise<number | null>((done) => child.once('exit', done));
    return { code, log };
}

async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'genie-refuse-'));
    homes.push(home);
    const runtime = join(home, 'runtime');
    await mkdir(runtime, { recursive: true });
    // The host's own derivation (genie-host.ts): the endpoint is keyed on the root it was given.
    const endpoint = hostEndpoint(process.platform, runtime, createHash('sha256').update(home).digest('hex').slice(0, 16));
    return { home, runtime, endpoint, keyFile: join(home, 'absent.key') };
}

describe('genie-host with a misconfigured file backend', () => {
    it('refuses on the secret store BEFORE the endpoint: with the endpoint already held, it still says the key, exits 1, and never connects', async () => {
        const f = await fixture();
        let connections = 0;
        const holder = createServer((socket) => { connections += 1; socket.destroy(); });
        servers.push(holder);
        await new Promise<void>((done, fail) => { holder.once('error', fail); holder.listen(f.endpoint, () => done()); });

        const { code, log } = await runHost(f.home, f.keyFile);
        expect(log).not.toMatch(/another host already serves/);
        expect(log).toContain(f.keyFile);
        expect(log).toMatch(/does not exist/);
        expect(code).toBe(1);
        expect(connections).toBe(0);
        expect(existsSync(join(f.runtime, 'host.json'))).toBe(false);
        expect(existsSync(join(f.home, 'secrets'))).toBe(false);
    }, 120_000);

    it('with the endpoint free: exits 1 in words, writes no host.json and leaves no endpoint behind', async () => {
        const f = await fixture();
        const { code, log } = await runHost(f.home, f.keyFile);
        expect(code).toBe(1);
        expect(log).toContain(f.keyFile);
        expect(existsSync(join(f.runtime, 'host.json'))).toBe(false);
        expect(existsSync(join(f.runtime, 'host.token'))).toBe(false);
        // Nothing listens there now: a server can take the endpoint.
        const probe = createServer();
        servers.push(probe);
        await new Promise<void>((done, fail) => { probe.once('error', fail); probe.listen(f.endpoint, () => done()); });
    }, 120_000);
});
