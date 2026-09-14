import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolveShuttleScript, shuttleEnv, shuttlePaths, stopStaleShuttle } from '../genie-launch';

/**
 * WHERE GENIE FINDS THE SHUTTLE TO START, AND HOW IT STOPS AN OLD ONE.
 *
 * genie#346 Phase 1, §3.2 and §9.3.1. Two facts about a packaged Genie shape this:
 *
 *  - The installer kills every process whose executable or script lives under the
 *    install directory, on every update (host-service.ts documents the predicate).
 *    A shuttle started from there would die on exactly the upgrade it exists to
 *    survive. So the bundle runs from a versioned copy in the user's data folder.
 *  - A deep upgrade replaces the running shuttle. The only handle on it is the pid
 *    it recorded, and a pid is not proof of identity: it is used only when the
 *    record also names THIS control channel, and the stop is not reported done
 *    until that channel has actually gone quiet.
 */

const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
    for (const pid of pids.splice(0)) {
        try {
            process.kill(pid);
        } catch {
            /* gone */
        }
    }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-launch-'));
    dirs.push(dir);
    return dir;
}

describe('resolveShuttleScript', () => {
    it('runs a PACKAGED bundle from a versioned copy outside the install directory', () => {
        const install = tmp();
        const userData = tmp();
        const unpacked = path.join(install, 'resources', 'app.asar.unpacked', 'app');
        fs.mkdirSync(unpacked, { recursive: true });
        fs.writeFileSync(path.join(unpacked, 'mcp-shuttle.js'), '// bundle v1');

        const script = resolveShuttleScript({
            mainBundleDir: path.join(install, 'resources', 'app.asar', 'app'),
            packaged: true,
            userDataDir: userData,
            version: '0.7.0-beta.324',
        });

        expect(script).not.toBeNull();
        expect(script!.startsWith(userData)).toBe(true);
        expect(script).toContain('0.7.0-beta.324');
        expect(fs.readFileSync(script!, 'utf8')).toBe('// bundle v1');
    });

    it('reuses a complete copy untouched — a running shuttle may be executing it', () => {
        const install = tmp();
        const userData = tmp();
        const unpacked = path.join(install, 'resources', 'app.asar.unpacked', 'app');
        fs.mkdirSync(unpacked, { recursive: true });
        fs.writeFileSync(path.join(unpacked, 'mcp-shuttle.js'), '// bundle v1');
        const opts = { mainBundleDir: path.join(install, 'resources', 'app.asar', 'app'), packaged: true, userDataDir: userData, version: '1.0.0' };
        const first = resolveShuttleScript(opts)!;
        fs.writeFileSync(path.join(unpacked, 'mcp-shuttle.js'), '// changed in place');

        const second = resolveShuttleScript(opts)!;

        expect(second).toBe(first);
        expect(fs.readFileSync(second, 'utf8')).toBe('// bundle v1');
    });

    it('replaces a TORN copy rather than trusting it', () => {
        const install = tmp();
        const userData = tmp();
        const unpacked = path.join(install, 'resources', 'app.asar.unpacked', 'app');
        fs.mkdirSync(unpacked, { recursive: true });
        fs.writeFileSync(path.join(unpacked, 'mcp-shuttle.js'), '// whole bundle');
        const opts = { mainBundleDir: path.join(install, 'resources', 'app.asar', 'app'), packaged: true, userDataDir: userData, version: '1.0.0' };
        const script = resolveShuttleScript(opts)!;
        // A crash mid-copy: a half file, and no completion marker.
        fs.writeFileSync(script, '// half');
        fs.rmSync(path.join(path.dirname(script), '.complete'));

        expect(fs.readFileSync(resolveShuttleScript(opts)!, 'utf8')).toBe('// whole bundle');
    });

    it('runs a DEV build’s bundle where webpack wrote it', () => {
        const repo = tmp();
        fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'app', 'mcp-shuttle.js'), '// dev');

        expect(resolveShuttleScript({ mainBundleDir: path.join(repo, 'app'), packaged: false, userDataDir: tmp(), version: 'dev' })).toBe(
            path.join(repo, 'app', 'mcp-shuttle.js'),
        );
    });

    it('is null when there is no bundle to run', () => {
        expect(resolveShuttleScript({ mainBundleDir: tmp(), packaged: false, userDataDir: tmp(), version: 'dev' })).toBeNull();
    });
});

describe('shuttleEnv', () => {
    it('gives the shuttle its configuration and none of Electron’s', () => {
        const env = shuttleEnv({
            base: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', GENIE_MCP_URL: 'http://x' },
            stateDir: '/state',
            port: 51717,
            wireGeneration: 2,
            version: '1.2.3',
        });

        expect(env).toMatchObject({
            PATH: '/bin',
            GENIE_SHUTTLE_STATE_DIR: '/state',
            GENIE_SHUTTLE_PORT: '51717',
            GENIE_SHUTTLE_WIRE_GENERATION: '2',
            GENIE_SHUTTLE_VERSION: '1.2.3',
        });
        expect(Object.keys(env).filter((k) => k.startsWith('ELECTRON_'))).toEqual([]);
        // A terminal's endpoint is not the shuttle's business.
        expect(env.GENIE_MCP_URL).toBeUndefined();
    });
});

describe('stopStaleShuttle', () => {
    /** A stand-in for an old shuttle: holds the control path, records itself. */
    async function staleShuttle(stateDir: string, controlPath: string, recordedPath = controlPath) {
        const script = path.join(stateDir, 'stale.cjs');
        fs.writeFileSync(
            script,
            `const net = require('net');
             const server = net.createServer(() => {});
             server.listen(${JSON.stringify(controlPath)}, () => {
                 require('fs').writeFileSync(${JSON.stringify(path.join(stateDir, 'shuttle.json'))},
                     JSON.stringify({ pid: process.pid, controlPath: ${JSON.stringify(recordedPath)} }));
                 process.send('ready');
             });`,
        );
        const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        pids.push(child.pid!);
        await new Promise<void>((resolve) => child.once('message', () => resolve()));
        child.disconnect();
        return child.pid!;
    }

    const answers = (controlPath: string) =>
        new Promise<boolean>((resolve) => {
            const s = net.connect(controlPath);
            s.once('connect', () => {
                s.destroy();
                resolve(true);
            });
            s.once('error', () => resolve(false));
        });

    it('stops the shuttle its record names, and returns only once its channel is quiet', async () => {
        const stateDir = tmp();
        const { controlPath } = shuttlePaths(stateDir);
        await staleShuttle(stateDir, controlPath);
        expect(await answers(controlPath)).toBe(true);

        await stopStaleShuttle({ stateDir, controlPath });

        expect(await answers(controlPath)).toBe(false);
    });

    it('REFUSES to kill a pid whose record names a different control channel', async () => {
        // A recycled pid, or a record from another data folder: either way the
        // pid is not proof it is the shuttle holding THIS channel.
        const stateDir = tmp();
        const { controlPath } = shuttlePaths(stateDir);
        const pid = await staleShuttle(stateDir, controlPath, `${controlPath}-elsewhere`);

        await expect(stopStaleShuttle({ stateDir, controlPath })).rejects.toThrow(/control channel/);

        expect(() => process.kill(pid, 0)).not.toThrow();
    });

    it('refuses without a record, rather than guessing what to stop', async () => {
        const stateDir = tmp();

        await expect(stopStaleShuttle({ stateDir, controlPath: shuttlePaths(stateDir).controlPath })).rejects.toThrow(
            /shuttle\.json/,
        );
    });
});
