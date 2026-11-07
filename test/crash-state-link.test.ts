import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CrashHeader, CrashRecord, HangNotice } from '../src/core/crash-record.js';
import { memoryPair } from '../src/core/line-transport.js';
import { CrashStateHost } from '../src/main/crash-state-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';

/**
 * THE CRASH RECORD REACHES THE WINDOW (#1623 review; Tynn story #386). genie-host keeps the latest CrashRecord (the
 * previous run's, read at boot, then each one its watchdog writes) and, after a hang it reopened the window for, the
 * NOTICE the new window shows. Both go to LOCAL windows over the engine link — before `engine.ready` and on every change
 * — so the reopened-window notice and the safe-mode banner hand the record to "Send a crash report". A remote window
 * (another machine's) is never sent it.
 */

const TOKEN = 'crash-state-token';
const HEADER: CrashHeader = { schema: 1, version: '2.0.0-beta.60', build: '2.0.0-beta.60+abc', os: 'linux', osRelease: '6.1.0', arch: 'x64', uptimeS: 42 };
const RECORD: CrashRecord = { ...HEADER, kind: 'hang', at: '2026-11-06T10:00:00.000Z', windowPid: 4242, lastBeatAt: '2026-11-06T09:59:30.000Z', lifecycle: [], stalls: [{ at: '2026-11-06T09:59:40.000Z', ms: 16600, route: null, stack: 'encode ndjson.js:9' }], memory: [], agents: [], relaunched: true, hangsRecent: 1 };
const NOTICE: HangNotice = { at: Date.UTC(2026, 10, 6, 10, 0, 0), hangs: 1, agents: [{ id: 'agent_a', name: 'tynn' }] };

async function link(state: CrashStateHost, local: boolean) {
    const server = new SessionEngineServer({ token: TOKEN, build: 't', crash: state });
    const [hostSide, windowSide] = memoryPair();
    server.accept(hostSide, { local });
    const client = new SessionEngineClient();
    expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
    return client;
}

describe('the host keeps the latest record and the notice', () => {
    it('the previous run’s record from boot; a new record replaces it; a hang’s notice; dismissed by the person', () => {
        const state = new CrashStateHost(RECORD);
        const seen: number[] = [];
        state.onChange(() => seen.push(1));
        expect(state.view()).toEqual({ record: RECORD, notice: null });
        const lost: CrashRecord = { ...HEADER, kind: 'lost', at: '2026-11-06T11:00:00.000Z', windowPid: 1, lastBeatAt: null, lastRssMb: null, lifecycle: [], memory: [] };
        state.recorded(lost);
        state.hung(NOTICE);
        expect(state.view()).toEqual({ record: lost, notice: NOTICE });
        expect(state.dismiss()).toEqual({ record: lost, notice: null });
        expect(seen).toEqual([1, 1, 1]);
    });
});

describe('over the engine link, to local windows only', () => {
    it('a local window has the record and the notice when it is ready, and hears a change', async () => {
        const state = new CrashStateHost(RECORD);
        const client = await link(state, true);
        expect(client.crashStateView()).toEqual({ record: RECORD, notice: null });
        const heard: unknown[] = [];
        client.onCrashState((view) => heard.push(view));
        state.hung(NOTICE);
        await vi.waitFor(() => expect(client.crashStateView()).toEqual({ record: RECORD, notice: NOTICE }));
        expect(heard).toHaveLength(1);
        // The person dismisses the notice: the host forgets it, for every window.
        expect(await client.dismissHangNotice()).toEqual({ ok: true });
        expect(state.view().notice).toBeNull();
        await vi.waitFor(() => expect(client.crashStateView()?.notice).toBeNull());
        client.disconnect();
    });

    it('CONTROL: a remote window is told nothing, and cannot dismiss it', async () => {
        const state = new CrashStateHost(RECORD);
        state.hung(NOTICE);
        const client = await link(state, false);
        expect(client.crashStateView()).toBeNull();
        expect(await client.dismissHangNotice()).toMatchObject({ ok: false });
        expect(state.view().notice).toEqual(NOTICE);
        client.disconnect();
    });
});

describe('the wiring', () => {
    const src = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

    it('genie-host: a hang reopens the installed Genie from the window’s published launch, and the state is kept and sent', () => {
        const host = src('src/main/genie-host.ts');
        expect(host).toMatch(/relaunch: \(\) => \{ spawnGenieWindow\(relaunchSpec\(updatesService\.launchSpec\(\), process\.env\), process\.env\); \}/);
        expect(host).toMatch(/const crashState = new CrashStateHost\(previousRunRecord\(join\(runtime, 'crash'\), parseHostRecord\(readOrNull\(recordFile\)\)\?\.startedAt \?\? null\)\);/);
        expect(host).toMatch(/crash: crashState,/);
        expect(host).toMatch(/onHang: \(hang\) => \{ crashState\.hung\(/);
        expect(host).toMatch(/write: \(record\) => \{ writeCrashRecord\(join\(runtime, 'crash'\), record\); crashState\.recorded\(record\); \}/);
    });

    it('window main: the notice in the snapshot, the record in the crash report, and the notice’s two actions', () => {
        const main = src('src/main/main.ts');
        expect(main).toMatch(/registry\.setHangNotice\(\(\) => agentEngineLink\?\.client\.crashStateView\(\)\?\.notice \?\? null\);/);
        expect(main).toMatch(/agentEngineLink\?\.client\.onCrashState\(\(\) => registry\?\.touch\(\)\);/);
        expect(main).toMatch(/record: \(\) => agentEngineLink\?\.client\.crashStateView\(\)\?\.record \?\? null,/);
        expect(main).toMatch(/notice: \(\) => agentEngineLink\?\.client\.crashStateView\(\)\?\.notice \?\? null,/);
        expect(main).toMatch(/hangNotice: \{/);
        const shell = src('src/renderer/Shell.tsx');
        expect(shell).toMatch(/<HangNoticeBar\s+notice=\{snapshot\.hangNotice\}/);
    });
});
