import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolStatus } from '../src/core/toolchain.js';
import type { ToolchainActivity } from '../src/core/toolchain-risk.js';
import type { RepairReport } from '../src/core/toolchain-repair.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, toolchainStateFrom, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { InstallOutcome } from '../src/main/toolchain-ops.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE TOOLCHAIN ACTIONS THROUGH THE FEATURE IPC — what the person's clicks do. The ports are fakes that COUNT: an
 * update the guard refuses never reaches the updater; an install without consent never reaches the installer; a
 * repair's findings, each with its result, are what the surface draws.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

const IDLE: ToolchainActivity = { sessions: [], processes: [], engines: [] };

let dir: string;
let services: ComposedServices;
let activity: ToolchainActivity;
let updates: string[];
let installs: Array<[string, boolean]>;
let probes: number;
let php: string | null;

const tools = (): ToolStatus[] => [
    { tool: 'claude-code', installed: '2.1.0', latest: '2.2.0', tone: 'update-available', source: 'npm' },
    { tool: 'node', installed: '22.23.2', latest: '22.24.0', tone: 'update-available', source: 'nodejs.org index (LTS)' },
    { tool: 'docker', installed: '27.3.1', latest: '28.0.0', tone: 'update-available', source: 'winget' },
    { tool: 'php', installed: php, latest: null, tone: php === null ? 'not-installed' : 'unknown', source: null },
];

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => { probes += 1; return tools(); },
        update: async (tool) => { updates.push(tool); return { kind: 'repaired', from: '1', to: '2' }; },
        now: () => 5_000,
        activity: async () => activity,
        install: async (tool, consent): Promise<InstallOutcome> => { installs.push([tool, consent]); php = '8.4.13'; return { kind: 'installed', version: '8.4.13' }; },
        preview: async (tool) => (tool === 'php' ? { label: 'winget install --id PHP.PHP.8.4 -e --silent --accept-source-agreements --accept-package-agreements', elevated: false } : { refused: 'no' }),
        repair: async (): Promise<RepairReport> => ({
            checkedAt: 7_000,
            findings: [
                { kind: 'path-shadow', tool: 'php', first: { path: 'C:\\Herd\\bin\\php.exe', version: '8.3.4' }, newer: { path: 'C:\\WinGet\\Links\\php.exe', version: '8.4.13' }, result: { kind: 'repaired', detail: 'Genie now runs php 8.4.13' } },
                { kind: 'vc-runtime', missing: ['msvcp140.dll'], result: { kind: 'needs-install', tool: 'vcredist', reason: 'PHP cannot start without msvcp140.dll.' } },
            ],
        }),
    },
});
const scanned = (): FeatureState => ({ toolStatuses: tools(), knowledgeQuery: '', toolchainCheckedAt: 1 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-toolchain-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    activity = IDLE; updates = []; installs = []; probes = 0; php = null;
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('T3 — the update guard, at the click', () => {
    it('updating claude-code while a Claude session runs is REFUSED naming it, and the updater is never called', async () => {
        activity = { ...IDLE, sessions: [{ label: 'atlas', provider: 'claude' }] };
        await expect(handleFeatureAction(services, { kind: 'toolchain.update', tool: 'claude-code' }, scanned(), ports())).rejects.toThrow(/atlas is running on Claude Code/);
        expect(updates).toEqual([]);
    });

    it('updating node while a Genie-run dev server is on it is REFUSED naming it; updater never called', async () => {
        activity = { ...IDLE, processes: [{ label: 'shop.gen dev server', command: 'npm run dev' }] };
        await expect(handleFeatureAction(services, { kind: 'toolchain.update', tool: 'node' }, scanned(), ports())).rejects.toThrow(/shop\.gen dev server is running on Node/);
        expect(updates).toEqual([]);
    });

    it('CONTROL: idle → the same updates run, once each, and the snapshot is the re-probe', async () => {
        await handleFeatureAction(services, { kind: 'toolchain.update', tool: 'claude-code' }, scanned(), ports());
        await handleFeatureAction(services, { kind: 'toolchain.update', tool: 'node' }, scanned(), ports());
        expect(updates).toEqual(['claude-code', 'node']);
        expect(probes).toBe(2);
    });

    it('docker with engines running: first a WARNING naming them (no update); "Update anyway" then updates', async () => {
        activity = { ...IDLE, engines: ['genie-svc-postgres'] };
        const warned = await handleFeatureAction(services, { kind: 'toolchain.update', tool: 'docker' }, scanned(), ports());
        expect(updates).toEqual([]);
        expect(warned.toolchain!.warning).toMatchObject({ tool: 'docker', affected: ['genie-svc-postgres'], reason: expect.stringContaining('stops genie-svc-postgres') });
        const done = await handleFeatureAction(services, { kind: 'toolchain.update', tool: 'docker', confirmed: true }, { ...scanned(), ...toolchainStateFrom(warned.toolchain) }, ports());
        expect(updates).toEqual(['docker']);
        expect(done.toolchain!.warning).toBeUndefined();
    });

    it('a REFUSAL is not confirmable: confirmed:true on a blocked update is still refused', async () => {
        activity = { ...IDLE, sessions: [{ label: 'atlas', provider: 'claude' }] };
        await expect(handleFeatureAction(services, { kind: 'toolchain.update', tool: 'claude-code', confirmed: true }, scanned(), ports())).rejects.toThrow(/atlas/);
        expect(updates).toEqual([]);
    });

    it('with no guard wired the update is refused, not run unguarded', async () => {
        const unguarded = ports();
        const { activity: _omit, ...rest } = unguarded.toolchain!;
        void _omit;
        await expect(handleFeatureAction(services, { kind: 'toolchain.update', tool: 'node' }, scanned(), { toolchain: rest })).rejects.toThrow(/update guard is not wired/);
        expect(updates).toEqual([]);
    });
});

describe('T1 — install, with consent, from the surface', () => {
    it('a scan lists how each MISSING tool would install (the command shown before anything runs)', async () => {
        const snap = await handleFeatureAction(services, { kind: 'toolchain.check', force: true }, scanned(), ports());
        expect(snap.toolchain!.installs).toEqual({ php: { label: expect.stringContaining('winget install --id PHP.PHP.8.4'), elevated: false } });
    });

    it('WITHOUT consent: refused, and the installer is never called', async () => {
        await expect(handleFeatureAction(services, { kind: 'toolchain.install', tool: 'php', consent: false }, scanned(), ports())).rejects.toThrow(/without your go-ahead/);
        expect(installs).toEqual([]);
    });

    it('with consent: installed once, then re-probed — the row is the measured version, the result line says so', async () => {
        const snap = await handleFeatureAction(services, { kind: 'toolchain.install', tool: 'php', consent: true }, scanned(), ports());
        expect(installs).toEqual([['php', true]]);
        expect(probes).toBe(1);
        expect(snap.toolchain!.tools.find((t) => t.tool === 'php')).toMatchObject({ installed: '8.4.13' });
        expect(snap.toolchain!.result).toBe('php 8.4.13 is installed.');
    });
});

describe('T2 — Check and repair, one action, a result per finding', () => {
    it('the findings and each one’s result reach the surface; installing the offered runtime clears its finding', async () => {
        const snap = await handleFeatureAction(services, { kind: 'toolchain.repair' }, scanned(), ports());
        expect(snap.toolchain!.findings!.map((f) => [f.kind, f.result.kind])).toEqual([['path-shadow', 'repaired'], ['vc-runtime', 'needs-install']]);
        expect(snap.toolchain!.result).toBe('2 problems found, 1 repaired.');
        expect(snap.toolchain!.repairedAt).toBe(7_000);
        const after = await handleFeatureAction(services, { kind: 'toolchain.install', tool: 'vcredist', consent: true }, { ...scanned(), ...toolchainStateFrom(snap.toolchain) }, ports());
        expect(after.toolchain!.findings!.map((f) => f.kind)).toEqual(['path-shadow']);
    });
});
