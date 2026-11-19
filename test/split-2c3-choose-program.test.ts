import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { REMOTE_METHODS, capabilityOf, inMemoryPair, parseMessage, type CallContext, type RemoteMethod, type WireMessage } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2c-3, THE PROVIDER'S PROGRAM (Tynn #898, story #897, task #1432; the coordinator's plan). The
 * .exe the person chooses for a provider hidden behind a batch wrapper (Tynn #577) is a protocol write answered by
 * genie-host, for the host's OWNER only, from any of the owner's clients. The window picks it on the HOST's disk with its
 * own host-disk picker (pickHostPath over host.listDir), never a native dialog of the machine the window runs on, so
 * another machine's owner can choose it too. genie-host writes its own choice file and reads the provider's health again.
 * main's genie:provider-choose-program (a native dialog) goes.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const OWNER: CallContext = { connectionId: 'rc_1', origin: 'remote-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'laptop' };
const METHOD = 'providers.chooseProgram' as RemoteMethod;
const EXE = 'C:\\Users\\fixture\\AppData\\Roaming\\npm\\claude.exe';

function programDeps() {
    const chosen: Array<[string, string]> = [];
    return { chosen, providerPrograms: { choose: (provider: string, path: string) => { chosen.push([provider, path]); return { ok: true as const }; } } };
}

describe('providers.chooseProgram is the host’s, for every client of its owner', () => {
    it('is a remote method, a write, not `local`; genie-host answers it', () => {
        expect(REMOTE_METHODS as readonly string[]).toContain(METHOD);
        expect(capabilityOf(METHOD)).toBe('write');
        expect(HOST_ALONE_METHODS.has(METHOD)).toBe(true);
    });

    it('the host API keeps a named provider’s program, and nothing for an unknown provider or a missing path', async () => {
        const d = programDeps();
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, providerPrograms: d.providerPrograms } as unknown as HostApiDeps);
        expect(await api.invoke(METHOD, ['claude', EXE], OWNER)).toEqual({ ok: true });
        expect(d.chosen).toEqual([['claude', EXE]]);
        expect(await api.invoke(METHOD, ['not-a-provider', EXE], OWNER)).toEqual({ ok: false, reason: 'No provider named.' });
        expect(await api.invoke(METHOD, ['claude', 42], OWNER)).toEqual({ ok: false, reason: 'No program chosen.' });
        expect(await api.invoke(METHOD, ['claude', ''], OWNER)).toEqual({ ok: false, reason: 'No program chosen.' });
        expect(d.chosen).toHaveLength(1);
    });

    it('CONTROL: with no program port the host says it cannot, in words', async () => {
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null } as unknown as HostApiDeps);
        expect(await api.invoke(METHOD, ['claude', EXE], OWNER)).toEqual({ ok: false, reason: 'this host cannot keep a provider’s program' });
    });

    it('a share-link guest is refused, and nothing is written', async () => {
        const home = await mkdtemp(join(tmpdir(), 'genie-2c3-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        try {
            const d = programDeps();
            const inner = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, providerPrograms: d.providerPrograms } as unknown as HostApiDeps);
            const api: HostApi = { invoke: (m: RemoteMethod, a: unknown[], ctx?: CallContext) => inner.invoke(m, a, ctx), onEvent: () => () => {}, workspaceOfAgent: () => 'ws_a' } as unknown as HostApi;
            let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void = () => {};
            new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing,
                transport: { onConnection: (l) => { accept = l; return () => {}; } } });
            const pair = inMemoryPair();
            const frames: WireMessage[] = [];
            pair.client.onMessage((m) => { const r = parseMessage(m); if (r.ok) frames.push(r.message); });
            accept({ ...pair.server, preAuth: { kind: 'relay', label: 'wren', isOwner: false, workspaceId: 'ws_a', readonly: false } });
            pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label: 'wren' }));
            await settle();
            expect(frames.some((m) => m.kind === 'welcome')).toBe(true);
            pair.client.send(JSON.stringify({ kind: 'call', id: 1, method: 'baton.take', args: [] }));
            pair.client.send(JSON.stringify({ kind: 'call', id: 2, method: METHOD, args: ['claude', EXE] }));
            await settle();
            expect(frames.find((m) => m.kind === 'result' && m.id === 2)).toMatchObject({ ok: false, reason: expect.stringMatching(/owner/) });
            expect(d.chosen).toEqual([]);
        } finally { await devices.flushed(); await rm(home, { recursive: true, force: true }); }
    });
});

describe('genie-host keeps the choice in its own file and reads the provider again', () => {
    it('hostProviderPrograms writes the choice and refreshes that provider; a batch file is refused and nothing refreshes', async () => {
        const { hostProviderPrograms } = await import('../src/main/host-provider-programs.js');
        const dir = await mkdtemp(join(tmpdir(), 'genie-2c3-file-'));
        try {
            const file = join(dir, 'provider-programs.json');
            const refreshed: string[] = [];
            const programs = hostProviderPrograms({ file: () => file, refresh: (p) => { refreshed.push(p); } });
            expect(programs.choose('claude', EXE)).toEqual({ ok: true });
            expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ claude: EXE });
            expect(refreshed).toEqual(['claude']);
            expect(programs.choose('codex', 'C:\\x\\codex.cmd')).toMatchObject({ ok: false, reason: expect.stringMatching(/\.exe/) });
            expect(refreshed).toEqual(['claude']);
            const nowhere = hostProviderPrograms({ file: () => null, refresh: (p) => { refreshed.push(p); } });
            expect(nowhere.choose('claude', EXE)).toEqual({ ok: false, reason: 'Genie has nowhere to keep the choice yet.' });
            expect(refreshed).toEqual(['claude']);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });

    it('genie-host composes it over its own choice file and its provider health', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/providerPrograms: hostProviderPrograms\(\{\s*file: \(\) => providerChoiceFile\(\),\s*refresh: \(provider\) => \{ void providerHealth\.refresh\(provider\); \}/);
    });
});

describe('every window picks the program on the host’s disk and asks the host', () => {
    it('the wire bridge asks providers.chooseProgram; this machine’s window asks it over its own connection', () => {
        expect(code(src('src/renderer/remote-bridge.ts'))).toMatch(/chooseProviderProgram: \(provider, path\) => answer<[^>]+>\('providers\.chooseProgram', provider, path\)/);
        expect(code(src('src/renderer/local-session.ts'))).toMatch(/chooseProviderProgram: \(provider, path\) => requestBridge\(\(bridge\) => bridge\.chooseProviderProgram!\(provider, path\)\)/);
        expect(code(src('src/renderer/bridge.ts'))).toMatch(/chooseProviderProgram: local\.chooseProviderProgram/);
    });

    it('the window uses its host-disk picker for an .exe or .com, never a one-argument native choose', () => {
        const app = code(src('src/renderer/App.tsx'));
        expect(app).toMatch(/pickHostPath\(\{ mode: 'file', title: `Choose \$\{provider\}'s program`, extensions: \['exe', 'com'\] \}\)/);
        expect(app).not.toMatch(/chooseProviderProgram!\(provider\)/);
    });
});

describe('main keeps no provider-program dialog of its own (source guards)', () => {
    it('no channel, no native open dialog, no preload line', () => {
        const main = code(src('src/main/main.ts'));
        for (const gone of ["'genie:provider-choose-program'", 'showOpenDialog(', 'writeProviderChoice(']) expect(main, gone).not.toContain(gone);
        expect(code(src('src/main/preload.ts'))).not.toContain('genie:provider-choose-program');
    });

    it('the row leaves the inventory and the frozen list', () => {
        expect(IPC_INVENTORY.map(([c]) => c)).not.toContain('genie:provider-choose-program');
        expect(src('test/ipc-inventory.test.ts')).not.toMatch(/'genie:provider-choose-program': '2c'/);
    });
});
