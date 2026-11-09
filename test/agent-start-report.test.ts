import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * AN AGENT THAT DOES NOT COME UP IS SAID, AND ITS START EXPLAINS ITSELF (Tynn #558). Seen on Windows CI: a provider was spawned
 * and its session never came up, with nothing said to anyone and nothing in the log to say where it stopped.
 */
let dir: string;
let host: SessionHost;
const noTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const REPORT_MS = 15;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phases: string[] = [];
const lifecycle = {
    spawned: () => {}, ended: () => {}, straggler: () => {},
    phase: (_agent: string, _run: number, phase: string) => { phases.push(phase); },
};

function driverWith(ready: Promise<void> | undefined): DriverFor {
    const factory: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, cliSessionId: null, ...(ready ? { ready } : {}) });
    return () => factory;
}
const atlas = (): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'atlas' });
const notices = (r: AgentRecord): string[] => host.rowsFor(r.id).flatMap((row) => (row.event.kind === 'notice' ? [row.event.message] : []));
const make = (driverFor: DriverFor, extra: object = {}) => new SessionHost({ userData: dir, driverFor, processTree: noTree, lifecycle, startReportMs: REPORT_MS, ...extra } as ConstructorParameters<typeof SessionHost>[0]);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-start-report-')); phases.length = 0; });
afterEach(async () => { host.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

describe('a start that does not come up', () => {
    it('the provider never answers: the person is told what it is waiting for, and the log says so', async () => {
        host = make(driverWith(new Promise(() => {})));
        const r = atlas();
        expect(host.start(r, dir)).toEqual({ ok: true });
        await pause(REPORT_MS * 4);
        expect(notices(r).join(' ')).toMatch(/atlas has not come up/);
        expect(notices(r).join(' ')).toMatch(/waiting for the provider to answer/);
        expect(phases).toEqual(['handshake', 'slow']);
    });

    it('its connections never finish preparing: that is what it says instead', async () => {
        host = make(driverWith(undefined), { prepareMcpServers: () => new Promise(() => {}) });
        const r = atlas();
        expect(host.start(r, dir)).toEqual({ ok: true });
        await pause(REPORT_MS * 4);
        expect(notices(r).join(' ')).toMatch(/waiting for its connections/);
        expect(phases).toEqual(['preparing', 'slow']);
    });

    it('prepared, then the provider never answers: the phases say where it stopped', async () => {
        host = make(driverWith(new Promise(() => {})), { prepareMcpServers: async () => [] });
        const r = atlas();
        host.start(r, dir);
        await pause(REPORT_MS * 4);
        expect(phases).toEqual(['preparing', 'handshake', 'slow']);
        expect(notices(r).join(' ')).toMatch(/the provider to answer/);
    });
});

describe('a start that does come up', () => {
    it('says nothing, and the log records that it was ready', async () => {
        host = make(driverWith(Promise.resolve()));
        const r = atlas();
        host.start(r, dir);
        await pause(REPORT_MS * 4);
        expect(notices(r)).toEqual([]);
        expect(phases).toEqual(['handshake', 'ready']);
    });

    it('a start that fails is logged as failed, and is not also reported as slow', async () => {
        const failing = Promise.reject(new Error('no'));
        failing.catch(() => {});
        host = make(driverWith(failing));
        host.start(atlas(), dir);
        await pause(REPORT_MS * 4);
        expect(phases).toEqual(['handshake', 'failed']);
    });

    it('CONTROL: a driver with no handshake is simply up: nothing is watched', async () => {
        host = make(driverWith(undefined));
        const r = atlas();
        host.start(r, dir);
        await pause(REPORT_MS * 4);
        expect(notices(r)).toEqual([]);
        expect(phases).not.toContain('slow');
    });
});
