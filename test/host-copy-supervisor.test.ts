import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { materializeHostRuntime, type HostRuntimeInput } from '../src/main/host-runtime.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';

/**
 * THE SUPERVISOR, THE HOST'S COPY AND THE MODEL LIST (beta.61's blocker). Measured on an installed beta.61:
 *
 *  1. A new agent's model list failed with "Genie's process supervisor could not run: prism-acp-supervisor.exe", with no path:
 *     the WINDOW asked the provider itself, and only genie-host prepares the supervisor. Its agents were starting fine.
 *  2. The host's copy never completed: the app's archive lists prism-acp's supervisor for BOTH architectures, the build ships
 *     only this machine's, so copying the other one failed (ENOENT) and the whole copy was abandoned, at every start. The
 *     host ran from the install: the thing the copy exists to prevent.
 */
const require = createRequire(import.meta.url);
let root: string;
function write(file: string, text = 'x'): void { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }
const PRISM = ['node_modules', '@particle-academy', 'prism-acp'];
const SUP = 'prism-acp-supervisor.exe';

/**
 * AN INSTALL AS ELECTRON SHOWS IT. `app` is the archive read as a folder: it lists every packed file, the unpacked ones too.
 * `app.unpacked` holds what really is on disk. The archive lists the supervisor for x64 and arm64; the build ships only x64.
 * Reading a listed file that is not on disk fails as it did on the owner's machine: ENOENT, naming the unpacked path.
 */
function install(over: Partial<HostRuntimeInput> = {}): HostRuntimeInput {
    const dist = join(root, 'install');
    const exe = join(dist, 'Genie.exe');
    write(exe, 'binary');
    for (const f of ['icudtl.dat', 'v8_context_snapshot.bin']) write(join(dist, f), f);
    const app = join(dist, 'resources', 'app');
    const unpacked = join(dist, 'resources', 'app.unpacked');
    write(join(app, 'dist', 'main', 'host.js'), 'host');
    write(join(app, 'package.json'), '{"type":"module"}');
    for (const [file, text] of [['package.json', '{"type":"module"}'], ['dist/index.js', 'prism'], ['native/supervisor-manifest.json', '{}'], [`native/win32-x64/${SUP}`, 'listed'], [`native/win32-arm64/${SUP}`, 'listed']] as const) {
        write(join(app, ...PRISM, file), text);
    }
    for (const [file, text] of [['package.json', '{"type":"module"}'], ['dist/index.js', 'prism'], ['native/supervisor-manifest.json', '{}'], [`native/win32-x64/${SUP}`, 'the x64 supervisor']] as const) {
        write(join(unpacked, ...PRISM, file), text);
    }
    mkdirSync(join(unpacked, ...PRISM, 'native', 'win32-arm64'), { recursive: true });
    const asarCopy: typeof copyFile = async (from, to) => {
        const rel = String(from).startsWith(app) ? String(from).slice(app.length) : null;
        // A file the archive lists as unpacked is read from the unpacked side, wherever it is asked for.
        const real = rel !== null && rel.includes(`${join('prism-acp', 'native')}`) ? join(unpacked, rel) : String(from);
        if (!existsSync(real)) throw Object.assign(new Error(`ENOENT: no such file or directory, copyfile '${real}'`), { code: 'ENOENT', path: real });
        copyFileSync(real, String(to));
    };
    return { packaged: true, platform: 'win32', arch: 'x64', execPath: exe, electronVersion: '45.0.0', appRoot: app, unpackedRoot: unpacked, hostHash: 'abc123', genieHome: join(root, 'home'), log: () => {}, copyFile: asarCopy, ...over } as HostRuntimeInput;
}
const copyOf = (input: HostRuntimeInput, ...rel: string[]) => join(input.genieHome, 'host', 'abc123', ...PRISM, ...rel);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'host-copy-sup-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('the copy, when the archive lists a supervisor the build did not ship', () => {
    it('is made: this machine’s supervisor is in it, byte for byte, and the host runs from it', async () => {
        const input = install();
        const got = await materializeHostRuntime(input);
        expect(got.error).toBeNull();
        expect(got.hostScript).toBe(join(input.genieHome, 'host', 'abc123', 'dist', 'main', 'host.js'));
        expect(readFileSync(copyOf(input, 'native', 'win32-x64', SUP), 'utf8')).toBe('the x64 supervisor');
        expect(existsSync(copyOf(input, 'package.json'))).toBe(true);
        expect(existsSync(join(input.genieHome, 'host', 'abc123', '.complete'))).toBe(true);
    });

    it('says which listed files the build did not ship', async () => {
        const lines: string[] = [];
        await materializeHostRuntime(install({ log: (l) => lines.push(l) }));
        expect(lines.join('\n')).toMatch(/win32-arm64[\\/]prism-acp-supervisor\.exe/);
    });

    it('on arm64 with only the x64 supervisor shipped: NOT made, said, and the host answers the install', async () => {
        const input = install({ arch: 'arm64' } as Partial<HostRuntimeInput>);
        const got = await materializeHostRuntime(input);
        expect(got.error).toMatch(/supervisor/);
        expect(got.hostScript).toBe(join(input.appRoot, 'dist', 'main', 'host.js'));
        expect(existsSync(join(input.genieHome, 'host', 'abc123', '.complete'))).toBe(false);
    });
});

describe('a copy already there is checked before it is used', () => {
    it('complete, but its supervisor is gone: rebuilt at this start', async () => {
        const input = install();
        await materializeHostRuntime(input);
        rmSync(copyOf(input, 'native', 'win32-x64', SUP));
        const again = await materializeHostRuntime(input);
        expect(again.error).toBeNull();
        expect(again.copied).toBe(true);
        expect(readFileSync(copyOf(input, 'native', 'win32-x64', SUP), 'utf8')).toBe('the x64 supervisor');
    });

    it('complete, but its supervisor is not the install’s: rebuilt', async () => {
        const input = install();
        await materializeHostRuntime(input);
        writeFileSync(copyOf(input, 'native', 'win32-x64', SUP), 'something else');
        const again = await materializeHostRuntime(input);
        expect(again.copied).toBe(true);
        expect(readFileSync(copyOf(input, 'native', 'win32-x64', SUP), 'utf8')).toBe('the x64 supervisor');
    });

    it('CONTROL: a good copy is kept, and nothing is copied again', async () => {
        const input = install();
        await materializeHostRuntime(input);
        expect((await materializeHostRuntime(input)).copied).toBe(false);
    });
});

describe('a provider’s model list is asked of genie-host, which has the supervisor', () => {
    const noTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

    it('over the engine link: the host’s answer, and its refresh', async () => {
        const asked: Array<[string, boolean]> = [];
        const server = new SessionEngineServer({
            token: 't', build: 'b',
            providerModels: async (provider: string, refresh: boolean) => { asked.push([provider, refresh]); return { ok: true as const, provider, source: 'provider' as const, models: [{ modelId: 'm1', name: 'M1' }], current: 'm1' }; },
        } as never);
        server.attach(new SessionHost({ userData: root, driverFor: () => null, processTree: noTree, ...server.hostOptions() }));
        const [h, raw] = memoryPair();
        server.accept(h, { local: true });
        const transport: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage(l), onClose: (l) => raw.onClose(l), close: () => raw.close() };
        const client = new SessionEngineClient({});
        expect(await client.connect(transport, 't')).toMatchObject({ ok: true });
        const models = (client as unknown as { providerModels(provider: string, options?: { refresh?: boolean }): Promise<unknown> }).providerModels;
        expect(await models.call(client, 'codex')).toMatchObject({ ok: true, models: [{ modelId: 'm1' }] });
        await models.call(client, 'codex', { refresh: true });
        expect(asked).toEqual([['codex', false], ['codex', true]]);
        transport.close();
    });

    it('the window asks no provider itself; genie-host answers from one cache', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).not.toMatch(/realListModels/);
        expect(main).toMatch(/models: \{ get: \(provider, options\) => agentEngineLink\.client\.providerModels\(provider, options\) \}/);
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        expect(host.match(/new ProviderModelCache\(realListModels\)/g)).toHaveLength(1);
        expect(host).toMatch(/providerModels: \(provider, refresh\) => providerModels\.get\(provider, \{ refresh \}\)/);
    });
});

describe('CI: the packaged host runs from its copy, with its supervisor', () => {
    const run = (): string => ((require('js-yaml').load(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: { package: { steps: Array<{ name?: string; run?: string }> } } }).jobs.package.steps.find((s) => s.name === 'the packaged app starts genie-host through genie-launch.exe')?.run ?? '');

    it('fails when the copy could not be made, when the host is not running from it, or when its supervisor is not ready', () => {
        const step = run();
        expect(step).toContain('the copy could not be made');
        expect(step).toContain('containment ready supervisor=');
        expect(step).toMatch(/\.genie\\host\\/);
        expect(step).toContain('is not running from its copy');
        // Read before anything is killed.
        expect(step.indexOf('containment ready supervisor=')).toBeLessThan(step.indexOf('Stop-Process'));
    });

    it('genie-host says so when its supervisor is ready, naming the file', () => {
        expect(readFileSync('src/main/genie-host.ts', 'utf8')).toMatch(/lifecycleLog\(`containment ready supervisor=\$\{supervisor\}`\)/);
    });
});
