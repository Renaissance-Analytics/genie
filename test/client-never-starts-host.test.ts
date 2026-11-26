import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineTransport } from '../src/core/line-transport.js';

/*
 * THE CLIENT LINKS AND NEVER STARTS A HOST (Tynn #1058 L4). The owner's ruling: "The client must open with no local host
 * running, so installs stay light and just connect to hosts." Only the launcher starts or stops a host. The client links to
 * the host that is running (host.json), whatever its build, and replaces none; with no host it shows the host directory.
 *
 * Every child-process start is caught here: a client with no host.json starts NO process at all.
 */
const started: string[] = [];
vi.mock('node:child_process', async (real) => {
    const actual = await real<typeof import('node:child_process')>();
    const caught = (name: string) => (...args: unknown[]) => { started.push(`${name} ${String(args[0])}`); throw new Error(`${name} must not run in the client`); };
    return { ...actual, spawn: caught('spawn'), execFile: caught('execFile'), fork: caught('fork'), exec: caught('exec'), spawnSync: caught('spawnSync'), execFileSync: caught('execFileSync') };
});

const { linkToHost } = await import('../src/main/engine-launch.js');
const { connectAgentEngine } = await import('../src/main/agent-engine.js');

const transport = (): LineTransport => ({ send: () => {}, onMessage: () => () => {}, onClose: () => () => {}, close: () => {}, trusted: () => {} });
const record = (over: Record<string, unknown> = {}) => JSON.stringify({ pid: 777, endpoint: 'pipe-777', protocol: 1, build: '2.0.0-beta.61+aaaaaaaaaaaa', startedAt: 1, ...over });

beforeEach(() => { started.length = 0; });

describe('a client with no host.json', () => {
    const ports = { runtimeDir: 'rt', logsDir: 'logs', build: '2.0.0-beta.62+bbbbbbbbbbbb', hostScript: 'host.js', execPath: 'genie', genieHome: 'home', env: {}, readFile: () => null, alive: () => true };

    it('links to nothing and starts no process', async () => {
        const dialled: string[] = [];
        await expect(linkToHost({ ...ports, connectTo: async (e: string) => { dialled.push(e); return transport(); } })).resolves.toBeNull();
        expect(started).toEqual([]);
        expect(dialled).toEqual([]);
    });

    it('the window\'s agent engine answers null (the directory is shown), and still starts no process', async () => {
        const link = await connectAgentEngine({ callbacks: {}, launch: ports, onError: () => {}, agentName: (id) => id, log: () => {} });
        expect(link).toBeNull();
        expect(started).toEqual([]);
    });

    it('a dead host\'s record is no host: nothing started, nothing ended', async () => {
        const kills: number[] = [];
        await expect(linkToHost({ ...ports, readFile: (f: string) => (f.endsWith('host.json') ? record() : 'tok'), alive: () => false, kill: (pid: number) => kills.push(pid) } as never)).resolves.toBeNull();
        expect(started).toEqual([]);
        expect(kills).toEqual([]);
    });
});

describe('a host of another build', () => {
    it('is adopted, not replaced: never asked to shut down, never ended, nothing started', async () => {
        const asked: number[] = [];
        const kills: number[] = [];
        const dialled: string[] = [];
        const link = await linkToHost({
            runtimeDir: 'rt', logsDir: 'logs', build: '2.0.0-beta.62+bbbbbbbbbbbb', hostScript: 'host.js', execPath: 'genie', genieHome: 'home', env: {},
            readFile: (f: string) => (f.endsWith('host.json') ? record() : 'tok\n'),
            alive: () => true,
            connectTo: async (e: string) => { dialled.push(e); return transport(); },
            askShutdown: async (r: { pid: number }) => { asked.push(r.pid); },
            kill: (pid: number) => { kills.push(pid); },
        } as never);
        expect(link).toMatchObject({ how: 'adopted', token: 'tok', record: { pid: 777, build: '2.0.0-beta.61+aaaaaaaaaaaa' } });
        expect(dialled).toEqual(['pipe-777']);
        expect(asked).toEqual([]);
        expect(kills).toEqual([]);
        expect(started).toEqual([]);
    });

    it('a live host of another ENGINE PROTOCOL is not this client\'s: the engine answers null (the directory says it needs an update), nothing ended or started', async () => {
        const dialled: string[] = [];
        const link = await connectAgentEngine({
            callbacks: {},
            launch: { runtimeDir: 'rt', readFile: (f: string) => (f.endsWith('host.json') ? record({ protocol: 999 }) : 'tok'), alive: () => true, connectTo: async (e: string) => { dialled.push(e); return transport(); } },
            onError: () => {}, agentName: (id) => id, log: () => {},
            sleep: () => new Promise<void>(() => {}),
        });
        expect(link).toBeNull();
        expect(dialled).toEqual([]);
        expect(started).toEqual([]);
    });

    it('a live host that does not answer yet is not ended: no link now, and it is tried again later', async () => {
        const kills: number[] = [];
        const link = await linkToHost({
            runtimeDir: 'rt', logsDir: 'logs', build: 'b', hostScript: 'host.js', execPath: 'genie', genieHome: 'home', env: {},
            readFile: (f: string) => (f.endsWith('host.json') ? record() : 'tok'), alive: () => true,
            connectTo: async () => { throw new Error('ECONNREFUSED'); },
            kill: (pid: number) => { kills.push(pid); },
        } as never);
        expect(link).toBeNull();
        expect(kills).toEqual([]);
        expect(started).toEqual([]);
    });
});

/** Every .ts/.tsx under a folder. */
function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx|cts|mts)$/.test(name) ? [p] : [];
    });
}
const code = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('the source guard', () => {
    const all = sources('src');
    const rel = (f: string) => relative('src', f).split(sep).join('/');

    it('reads the tree (positive control: it finds linkToHost where it is defined)', () => {
        expect(all.length).toBeGreaterThan(100);
        expect(all.filter((f) => /export async function linkToHost\b/.test(code(f))).map(rel)).toEqual(['main/engine-launch.ts']);
    });

    it('no spawnHostProcess in the client: it is defined and used only in the single-app install\'s quarantined module', () => {
        expect(all.filter((f) => /\b(spawnHostProcess|hostSpawnSpec)\b/.test(code(f))).map(rel)).toEqual(['main/legacy-host-start.ts']);
    });

    it('that module is reached from main.ts alone, only for a process no launcher started, and it names its removal (L9, the bridge)', () => {
        const importers = all.filter((f) => /from '\.\/legacy-host-start\.js'/.test(code(f))).map(rel);
        expect(importers).toEqual(['main/main.ts']);
        const main = code(join('src', 'main', 'main.ts'));
        expect(main.match(/legacyHostFinder\(/g)).toHaveLength(1);
        expect(main).toMatch(/find: launched === null \? legacyHostFinder\(/);
        const header = readFileSync(join('src', 'main', 'legacy-host-start.ts'), 'utf8').split(/\r?\n/).slice(0, 20).join('\n');
        expect(header).toMatch(/L9/);
        expect(header).toMatch(/bridge/i);
    });

    it('the window has no host-start dialog and no host copy for a launched client: the directory instead', () => {
        const main = code(join('src', 'main', 'main.ts'));
        expect(main).not.toMatch(/stopForNoHost/);
        expect(main).toMatch(/openHostDirectory\(/);
        expect(main).toMatch(/launched \? null : await materializeHostRuntime\(/);
    });

    it('the client\'s own link (engine-launch.ts, agent-engine.ts) can neither start nor replace a host', () => {
        for (const file of ['engine-launch.ts', 'agent-engine.ts']) {
            const text = code(join('src', 'main', file));
            expect(text, file).not.toMatch(/askShutdown|startTimeoutMs|\bspawnHost\b|kill:\s*killPid/);
        }
    });
});
