import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IPC_INVENTORY, WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { REMOTE_METHODS, capabilityOf, inMemoryPair, parseMessage, type CallContext, type RemoteMethod, type WireMessage } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * CLIENT/HOST SPLIT STEP 2c-2, THE CRASH REPORT (Tynn #898, story #897, task #1431; the coordinator's ruling). The
 * safe-mode / hang / renderer-notice banner's crash report (Tynn #386 part 4) is a protocol call answered by genie-host,
 * built from genie-host's own pieces (its safe mode, its crash state, its registry, its workstation identity), for the
 * host's OWNER only and for every client of the owner's, this machine's window and another machine's alike (not `local`).
 * Nothing is sent until the person presses Send. main's draft/send channels, its crash-report host and its copies of the
 * safe mode and hang notice in its registry go.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const OWNER: CallContext = { connectionId: 'rc_1', origin: 'remote-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'laptop' };
const METHODS = ['crashReport.draft', 'crashReport.send'] as RemoteMethod[];

function crashDeps() {
    const sent: Array<[string, string]> = [];
    return {
        sent,
        crashReports: {
            draft: () => ({ text: 'Genie crashed at 10:00 (fixture)' }),
            send: async (text: string, notes: string) => { sent.push([text, notes]); return { ok: true as const, issueUrl: 'https://tynn.example/issues/1' }; },
        },
    };
}

describe('crashReport.draft and crashReport.send are the host’s, for every client of its owner', () => {
    it('are remote methods: the draft a read, the send a write; neither `local`; genie-host answers them', () => {
        for (const m of METHODS) {
            expect(REMOTE_METHODS as readonly string[]).toContain(m);
            expect(HOST_ALONE_METHODS.has(m), m).toBe(true);
        }
        expect(capabilityOf(METHODS[0]!)).toBe('read');
        expect(capabilityOf(METHODS[1]!)).toBe('write');
    });

    it('the host API answers the draft and sends only what the person sends', async () => {
        const c = crashDeps();
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, crashReports: c.crashReports } as unknown as HostApiDeps);
        expect(await api.invoke(METHODS[0]!, [], OWNER)).toEqual({ text: 'Genie crashed at 10:00 (fixture)' });
        expect(await api.invoke(METHODS[1]!, ['the text', 'my notes'], OWNER)).toEqual({ ok: true, issueUrl: 'https://tynn.example/issues/1' });
        expect(c.sent).toEqual([['the text', 'my notes']]);
        expect(await api.invoke(METHODS[1]!, [42, null], OWNER)).toEqual({ ok: false, reason: 'A crash report needs its text.' });
        expect(c.sent).toHaveLength(1);
    });

    it('a share-link guest is refused both, and nothing is read or sent', async () => {
        const home = await mkdtemp(join(tmpdir(), 'genie-2c2-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        try {
            const c = crashDeps();
            let drafted = 0;
            const inner = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, crashReports: { ...c.crashReports, draft: () => { drafted += 1; return c.crashReports.draft(); } } } as unknown as HostApiDeps);
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
            pair.client.send(JSON.stringify({ kind: 'call', id: 2, method: METHODS[0], args: [] }));
            pair.client.send(JSON.stringify({ kind: 'call', id: 3, method: METHODS[1], args: ['t', 'n'] }));
            await settle();
            expect(frames.find((m) => m.kind === 'result' && m.id === 2)).toMatchObject({ ok: false, reason: expect.stringMatching(/owner/) });
            expect(frames.find((m) => m.kind === 'result' && m.id === 3)).toMatchObject({ ok: false, reason: expect.stringMatching(/owner/) });
            expect({ drafted, sent: c.sent }).toEqual({ drafted: 0, sent: [] });
        } finally { await devices.flushed(); await rm(home, { recursive: true, force: true }); }
    });

    it('CONTROL: with no crash-report port the host says it cannot, in words', async () => {
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null } as unknown as HostApiDeps);
        expect(await api.invoke(METHODS[1]!, ['t', 'n'], OWNER)).toEqual({ ok: false, reason: 'this host cannot send a crash report' });
    });
});

describe('genie-host builds the report from its own pieces; every bridge asks it', () => {
    it('genie-host composes crashReportHost over its safe mode, crash state and workstation identity', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/crashReportHost\(\{[\s\S]{0,1200}view: \(\) => safeMode\.view\(\)/);
        expect(host).toMatch(/crashReportHost\(\{[\s\S]{0,1200}record: \(\) => crashState\.view\(\)\.record/);
        expect(host).toMatch(/crashReportHost\(\{[\s\S]{0,1600}authHeader: \(\) => workstationService\.authHeader\(TYNN_HOST\)/);
    });

    it('the wire bridge asks crashReport.draft / crashReport.send, so another machine’s owner has it too', () => {
        const remote = code(src('src/renderer/remote-bridge.ts'));
        expect(remote).toMatch(/crashReport: \{\s*draft: async \(\) => \{ const r = await call\('crashReport\.draft'\)/);
        expect(remote).toMatch(/send: \(text, notes\) => answer<CrashReportAnswer>\('crashReport\.send', text, notes\)/);
        expect(code(src('src/renderer/bridge.ts'))).toMatch(/crashReport: local\.crashReport/);
    });
});

describe('main keeps no crash report of its own (source guards)', () => {
    const main = code(src('src/main/main.ts'));

    it('no channels, no crash-report host, no registry copies of the safe mode or the hang notice', () => {
        for (const gone of ["'genie:crash-report-draft'", "'genie:crash-report-send'", 'crashReportHost(', 'registry.setSafeMode(', 'registry.setHangNotice(', 'onCrashState(']) expect(main, gone).not.toContain(gone);
        expect(code(src('src/main/preload.ts'))).not.toContain('genie:crash-report-');
    });

    it('the rows leave both inventories and both frozen lists', () => {
        expect(IPC_INVENTORY.map(([c]) => c).filter((c) => c.startsWith('genie:crash-report-'))).toEqual([]);
        expect(WINDOW_ENGINE_INVENTORY.map(([u]) => u).filter((u) => ['crashStateView', 'onCrashState', 'safeModeView'].includes(u))).toEqual([]);
        expect(src('test/ipc-inventory.test.ts')).not.toMatch(/'genie:crash-report-(draft|send)': '2c'/);
        expect(src('test/split-2e-window-guard.test.ts')).not.toMatch(/crashStateView: '2c'|onCrashState: '2c'|safeModeView: '2c'/);
    });
});
