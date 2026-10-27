import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepairOutcome, ToolStatus } from '../src/core/toolchain.js';
import type { ToolchainActivity } from '../src/core/toolchain-risk.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, toolchainStateFrom, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import type { FeatureAction, FeatureData } from '../src/renderer/features.js';

/**
 * genie#1306 — THE UPDATE BUTTON'S ROUND TRIP: the renderer's action crosses the bridge (structured-cloned, as Electron's
 * IPC does), main runs the update for the version the button names, restarts what ran on the old version when the person
 * chose that, and the answer carries the measured result — or the failure, in words, on that row, with a Retry.
 */

let opened = 0;
const pty: PtyPort = {
    open: (o) => { opened += 1; return { id: `term_${opened}`, pid: 1000 + opened, shell: o.command ?? 'sh', scrollback: '' }; },
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let updates: Array<[string, string | undefined]>;
let outcome: RepairOutcome | { kind: 'refused'; reason: string };
let sessions: ToolchainActivity['sessions'];
let installed: string;
let steps: Array<string | null>;

const PHP = (): ToolStatus => ({
    tool: 'php', installed, latest: '8.5.12', tone: installed === '8.4.27' ? 'update-available' : 'security-update', source: 'php.net releases',
    ...(installed === '8.4.27' ? {} : { advisory: 'PHP 8.4.24 is vulnerable to CVE-2026-109618 / CVE-2026-109619 (remote code execution); update to 8.4.27' }),
});

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [PHP()],
        update: async (tool, version) => {
            updates.push([tool, version]);
            if (outcome.kind === 'repaired') installed = outcome.to;
            return outcome;
        },
        now: () => 5_000,
        // As main.ts reads it: every running Genie process, with its id, name and command.
        activity: async (): Promise<ToolchainActivity> => ({
            sessions,
            processes: services.supervisor.list().filter((p) => p.state === 'running').map((p) => ({ id: p.id, label: p.name, command: services.supervisor.command(p.id) ?? '' })),
            engines: [],
        }),
        updating: (row) => { steps.push(row?.step ?? null); },
    },
});

const scanned = (): FeatureState => ({ toolStatuses: [PHP()], knowledgeQuery: '', toolchainCheckedAt: 1 });

/** Through the bridge and back, as Electron's IPC carries it. */
async function click(action: FeatureAction, state: FeatureState = scanned()): Promise<FeatureData> {
    return structuredClone(await handleFeatureAction(services, structuredClone(action), state, ports()));
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-1306-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    updates = []; sessions = []; installed = '8.4.24'; steps = []; opened = 0;
    outcome = { kind: 'repaired', from: '8.4.24', to: '8.4.27' };
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

/** The owner's machine, small: a Laravel site's dev server and a kept queue worker run on PHP; a vite server does not. */
function phpRunning(): void {
    services.sites.create({ name: 'flabs', workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, devServer: { stack: 'laravel', command: 'php artisan serve --host=127.0.0.1 --port={port}' } });
    services.supervisor.start({ id: 'proc_queue', workspaceId: 'tynn', name: 'flabs queue worker', command: 'php artisan queue:work', cwd: dir, restart: 'on-failure' });
    services.supervisor.start({ id: 'proc_vite', workspaceId: 'tynn', name: 'flabs vite', command: 'npm run dev', cwd: dir, restart: 'on-failure' });
}

describe('#1306 — the Update button reaches main with the version it names', () => {
    it('“Update to 8.4.27” runs the update FOR 8.4.27, and the answer is the re-probe, marked updated on the row', async () => {
        const snap = await click({ kind: 'toolchain.update', tool: 'php', version: '8.4.27' });
        expect(updates).toEqual([['php', '8.4.27']]);
        expect(snap.toolchain!.tools[0]).toMatchObject({ tool: 'php', installed: '8.4.27' });
        expect(snap.toolchain!.updated).toEqual({ tool: 'php', version: '8.4.27' });
        expect(snap.toolchain!.refusals).toBeUndefined();
        // The row showed it was working while it ran, and the working state is gone at the end.
        expect(steps[0]).toEqual(expect.any(String));
        expect(steps.at(-1)).toBeNull();
    });

    it('a failure comes back ON THE ROW, in words, with the version to Retry — never a silent no-op', async () => {
        outcome = { kind: 'unchanged', installed: '8.4.24', reason: 'PHP 8.4.27 could not be installed: windows.php.net’s releases.json could not be read (HTTP 503)' };
        const snap = await click({ kind: 'toolchain.update', tool: 'php', version: '8.4.27' });
        expect(snap.toolchain!.refusals).toEqual([{ tool: 'php', reason: expect.stringMatching(/HTTP 503/), retry: '8.4.27' }]);
        expect(snap.toolchain!.updated).toBeUndefined();
    });
});

describe('#1306 — what ran on the old version: one short warning, and ONE choice — restart them (default) or not', () => {
    it('first click: no update yet; the warning counts and names what runs on PHP (not the vite server) and keeps the version', async () => {
        phpRunning();
        const warned = await click({ kind: 'toolchain.update', tool: 'php', version: '8.4.27' });
        expect(updates).toEqual([]);
        expect(warned.toolchain!.warning).toMatchObject({ tool: 'php', version: '8.4.27', affected: ['flabs.gen dev server', 'flabs queue worker'] });
    });

    it('“Update and restart”: updated, then exactly those restarted — the site through its own restart (php re-resolved), the worker by the supervisor', async () => {
        phpRunning();
        const warned = await click({ kind: 'toolchain.update', tool: 'php', version: '8.4.27' });
        const siteRestarts: string[] = [];
        const procRestarts: string[] = [];
        const siteRestart = services.sites.restart.bind(services.sites);
        const procRestart = services.supervisor.restart.bind(services.supervisor);
        services.sites.restart = (id) => { siteRestarts.push(id); return siteRestart(id); };
        services.supervisor.restart = (id) => { procRestarts.push(id); return procRestart(id); };
        const done = await click({ kind: 'toolchain.update', tool: 'php', version: '8.4.27', confirmed: true, restart: true }, { ...scanned(), ...toolchainStateFrom(warned.toolchain) });
        expect(updates).toEqual([['php', '8.4.27']]);
        expect(siteRestarts).toEqual([services.sites.list()[0]!.id]);
        expect(procRestarts).toEqual(['proc_queue']);
        expect(done.toolchain!.warning).toBeUndefined();
        expect(done.toolchain!.result).toMatch(/Restarted 2/);
        expect(steps).toContain('Restarting');
    });

    it('“Update only”: updated, nothing restarted, and the result says what still runs the old PHP', async () => {
        phpRunning();
        const procRestarts: string[] = [];
        const procRestart = services.supervisor.restart.bind(services.supervisor);
        services.supervisor.restart = (id) => { procRestarts.push(id); return procRestart(id); };
        const done = await click({ kind: 'toolchain.update', tool: 'php', version: '8.4.27', confirmed: true, restart: false });
        expect(updates).toEqual([['php', '8.4.27']]);
        expect(procRestarts).toEqual([]);
        expect(done.toolchain!.result).toMatch(/flabs\.gen dev server/);
        expect(done.toolchain!.result).toMatch(/flabs queue worker/);
    });

    it('a failed update restarts nothing', async () => {
        phpRunning();
        outcome = { kind: 'unchanged', installed: '8.4.24', reason: 'nope' };
        const procRestarts: string[] = [];
        const procRestart = services.supervisor.restart.bind(services.supervisor);
        services.supervisor.restart = (id) => { procRestarts.push(id); return procRestart(id); };
        await click({ kind: 'toolchain.update', tool: 'php', version: '8.4.27', confirmed: true, restart: true });
        expect(procRestarts).toEqual([]);
    });
});

describe('#1306 — Node is a Genie-managed version now: a running agent is a warning, not a wall', () => {
    it('agents running: warned (they keep the old Node until they next start), and the update can go ahead — agents are never restarted', async () => {
        sessions = [{ label: 'atlas', provider: 'claude' }];
        const warned = await handleFeatureAction(services, { kind: 'toolchain.update', tool: 'node', version: '24.22.1' }, scanned(), ports());
        expect(warned.toolchain!.refusals).toBeUndefined();
        expect(warned.toolchain!.warning).toMatchObject({ tool: 'node', version: '24.22.1', affected: ['atlas'] });
        outcome = { kind: 'repaired', from: '24.19.0', to: '24.22.1' };
        await handleFeatureAction(services, { kind: 'toolchain.update', tool: 'node', version: '24.22.1', confirmed: true, restart: true }, scanned(), ports());
        expect(updates).toEqual([['node', '24.22.1']]);
    });
});
