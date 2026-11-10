import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/*
 * Tynn #575. A client's antivirus quarantined prism-acp's supervisor, which was compiled at first use with csc.exe into
 * AppData, unsigned: a classic dropper pattern. The agent said only "could not prepare its private MCP connection".
 * prism-acp 0.41 ships a prebuilt, pinned supervisor for each architecture. Genie unpacks it from the asar, signs it with
 * the app, hands its absolute path to prepareProcessTree once at startup, and says plainly when it cannot run.
 */
const prepared = vi.hoisted(() => ({ calls: [] as unknown[], fail: null as Error | null }));
vi.mock('@particle-academy/prism-acp', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    prepareProcessTree: async (options: unknown) => { prepared.calls.push(options); if (prepared.fail) throw prepared.fail; },
    supervisorPath: () => 'C:\\Programs\\Genie\\resources\\app.asar\\node_modules\\@particle-academy\\prism-acp\\native\\win32-x64\\prism-acp-supervisor.exe',
}));
const load = async () => { const path: string = '../src/main/prism-supervisor.js'; return import(path) as Promise<any>; };
const words = async () => { const path: string = '../src/core/supervisor-failure.js'; return import(path) as Promise<any>; };
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const EXE = 'C:\\Programs\\Genie\\resources\\app.asar.unpacked\\node_modules\\@particle-academy\\prism-acp\\native\\win32-x64\\prism-acp-supervisor.exe';
const onWindows = <T>(run: () => Promise<T>): Promise<T> => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
    return run().finally(() => Object.defineProperty(process, 'platform', real));
};

describe('prism-acp 0.41, shipped and signed', () => {
    it('pins 0.41.1, signed by Renaissance Analytics', () => {
        expect((JSON.parse(read('package.json')) as { dependencies: Record<string, string> }).dependencies['@particle-academy/prism-acp']).toBe('0.41.1');
    });

    it('unpacks the prebuilt supervisors from the asar (the package picks by the machine, so an x64 Genie on ARM64 needs both)', () => {
        expect(read('electron-builder.yml')).toMatch(/^\s*- "\*\*\/node_modules\/@particle-academy\/prism-acp\/native\/\*\*"/m);
    });

    it('keeps prism-acp out of the bundle, or its own files resolve to nothing', () => {
        expect(read('vite.main.config.ts')).toMatch(/external: \[[^\]]*'@particle-academy\/prism-acp'/);
    });

    it('the signature check requires them by name: an empty tree cannot pass', () => {
        const check = read('scripts/verify-windows-signatures.ps1');
        expect(check).toContain('resources/app.asar.unpacked/node_modules/@particle-academy/prism-acp/native/win32-x64/prism-acp-supervisor.exe');
        expect(check).toContain('resources/app.asar.unpacked/node_modules/@particle-academy/prism-acp/native/win32-arm64/prism-acp-supervisor.exe');
    });

    it('the packed-tree check requires both, and the sign plan signs them', async () => {
        const tree: string = '../scripts/packed-tree-check.mjs', plan: string = '../scripts/win-sign-plan.mjs';
        const { required, leftovers } = await import(tree) as { required: () => string[]; leftovers: (files: string[]) => unknown[] };
        const { shouldSignFile } = await import(plan) as { shouldSignFile: (file: string, signExts: readonly string[]) => boolean };
        const signExts = (/^\s*signExts: \[(.*)\]$/m.exec(read('electron-builder.yml'))?.[1] ?? '').split(',').map((e) => e.trim().replace(/^'|'$/g, ''));
        const files = ['resources/app.asar.unpacked/node_modules/@particle-academy/prism-acp/native/win32-x64/prism-acp-supervisor.exe', 'resources/app.asar.unpacked/node_modules/@particle-academy/prism-acp/native/win32-arm64/prism-acp-supervisor.exe'];
        for (const file of files) {
            expect(required()).toContain(file);
            expect(shouldSignFile(`C:/out/win-unpacked/${file}`, signExts)).toBe(true);
        }
        expect(leftovers(files)).toEqual([]);
    });

    it('no compiler is involved any more: Genie no longer reads the supervisor source', () => {
        expect(read('src/main/prism-supervisor.ts')).not.toContain('SUPERVISOR_CS');
        expect(read('src/main/prism-supervisor.ts')).not.toMatch(/directory:/);
    });
});

describe('at startup', () => {
    it('the path handed over is the unpacked one, and a path outside an asar is left alone', async () => {
        const { unpackedSupervisorPath } = await load();
        expect(unpackedSupervisorPath(EXE.replace('app.asar.unpacked', 'app.asar'))).toBe(EXE);
        expect(unpackedSupervisorPath(EXE)).toBe(EXE);
        expect(unpackedSupervisorPath('C:\\dev\\genie\\node_modules\\x.exe')).toBe('C:\\dev\\genie\\node_modules\\x.exe');
    });

    it('prepares it with that absolute path and no folder', async () => {
        const { prepareGenieSupervisor } = await load();
        prepared.calls.length = 0;
        await onWindows(() => prepareGenieSupervisor());
        expect(prepared.calls).toEqual([{ executable: EXE }]);
    });

    it('genie-host does it once, before any agent starts; the window runs no agents, so never (Tynn #415)', () => {
        const code = (file: string) => read(file).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(code('src/main/genie-host.ts').match(/prepareGenieSupervisor\(\)/g)).toHaveLength(1);
        expect(code('src/main/main.ts')).not.toMatch(/prepareGenieSupervisor\(/);
        expect(code('src/main/genie-host.ts').indexOf('prepareGenieSupervisor()')).toBeLessThan(code('src/main/genie-host.ts').indexOf('new SessionHost('));
    });
});

describe('when the supervisor cannot run', () => {
    const FILE = 'C:\\Programs\\Genie\\resources\\app.asar.unpacked\\native\\prism-acp-supervisor.exe';

    it.each([
        ['missing', 'the shipped supervisor is unavailable; install the complete package or pass an unpacked executable to prepareProcessTree'],
        ['altered', 'the supervisor executable does not match the shipped Authenticode pin; no provider was started'],
        ['refused earlier', 'the configured supervisor was refused; prepare a valid unpacked executable before launching a provider'],
        ['the adapter', 'cannot prepare Claude approval adapter: the shipped supervisor is unavailable'],
    ])('%s: names the file and the antivirus', async (_case, message) => {
        const { supervisorFailureWords } = await words();
        const said = supervisorFailureWords(Object.assign(new Error(message), { name: 'ProcessTreeError' }), FILE);
        expect(said).toContain(FILE);
        expect(said).toMatch(/antivirus/i);
    });

    it('a spawn the OS refused on that file is the same', async () => {
        const { supervisorFailureWords } = await words();
        const error = Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN', path: FILE, spawnargs: [] });
        expect(supervisorFailureWords(error, FILE)).toMatch(/antivirus/i);
    });

    it('CONTROL: anything else is not that', async () => {
        const { supervisorFailureWords } = await words();
        expect(supervisorFailureWords(new Error('the provider binary was not found on PATH'), FILE)).toBeNull();
        expect(supervisorFailureWords(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', path: 'C:\\x\\claude.exe' }), FILE)).toBeNull();
    });

    it('the agent says that, never the generic MCP message', async () => {
        const { mcpPreparationMessage } = await import('../src/main/mcp-preparation-error.js');
        const said = mcpPreparationMessage(Object.assign(new Error('the supervisor executable has an invalid PE image; no provider was started'), { name: 'ProcessTreeError' }));
        expect(said).toMatch(/antivirus/i);
        expect(said).not.toMatch(/private MCP connection/);
    });

    it('CONTROL: an unrelated preparation failure stays the fixed message, and nothing from it leaks', async () => {
        const { mcpPreparationMessage } = await import('../src/main/mcp-preparation-error.js');
        const said = mcpPreparationMessage(new Error('secret-key-123 was rejected'));
        expect(said).toBe('The agent could not prepare its private MCP connection. Restart to try again.');
    });

    it('the model list and a failed start say it too', async () => {
        const { modelListReason } = await import('../src/core/provider-models.js');
        expect(modelListReason('codex', Object.assign(new Error('the shipped supervisor is unavailable; install the complete package'), { name: 'ProcessTreeError' }))).toMatch(/antivirus/i);
        expect(read('src/main/session-host.ts')).toMatch(/supervisorFailureWords\(error\)/);
    });
});
