import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_METHODS, LAUNCHER_LINK_METHODS } from '../src/core/engine-protocol.js';
import type { CallContext } from '../src/core/remote-protocol.js';
import type { ToolStatus } from '../src/core/toolchain.js';
import { LAUNCHER_FEATURE_CALLER, launcherToolchain, type LauncherToolchainFeatures } from '../src/main/launcher-toolchain.js';
import type { FeatureAction, FeatureData, ToolchainSection } from '../src/renderer/features.js';

/**
 * THE HOST'S TOOLS IN THE LAUNCHER'S UPDATES (Tynn #1058 L7, #716). The launcher's Updates list shows the host's toolchain
 * rows beside its tracks, and applying one is the host's own installer (`toolchain.update`, what Settings → Toolchain's
 * Update runs): the launcher reads and asks, over its link (`engine.toolchain`), and installs nothing itself.
 */

/** A source file with LF line ends (a tree checked out on Windows has CRLF, and the queue ships it as it is). */
const src = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const TOOLS: ToolStatus[] = [
    { tool: 'node', installed: '24.10.0', latest: '25.1.0', tone: 'update-available', source: 'genie', patch: '24.11.1', upgrade: '25.1.0' },
    { tool: 'git', installed: '2.51.0', latest: '2.51.0', tone: 'up-to-date', source: 'system' },
    { tool: 'claude-code', installed: '2.1.3', latest: '2.1.5', tone: 'security-update', source: 'npm', advisory: 'CVE-2026-0001: update to 2.1.5' },
    { tool: 'docker', installed: null, latest: null, tone: 'not-installed', source: null },
];

function fakeFeatures(section: Partial<ToolchainSection> | null, opts: { slowAct?: boolean } = {}) {
    const acts: { action: FeatureAction; context: CallContext }[] = [];
    const snaps: CallContext[] = [];
    let finish: () => void = () => {};
    const data = () => ({ toolchain: section === null ? null : { tools: TOOLS, checkedAt: 1_700_000_000_000, ...section } }) as unknown as FeatureData;
    const features: LauncherToolchainFeatures = {
        snapshot: async (context) => { snaps.push(context); return data(); },
        act: (action, context) => {
            acts.push({ action, context });
            if (!opts.slowAct) return Promise.resolve(data());
            return new Promise((resolve) => { finish = () => resolve(data()); });
        },
    };
    return { features, acts, snaps, finish: () => finish() };
}

type Rows = { rows: Array<Record<string, unknown>>; checkedAt: number | null; checking: boolean };

describe('the launcher reads the host’s tools (engine.toolchain state)', () => {
    it('only the tools with an update are rows, each with what it updates to (the patch first) and its words', async () => {
        const f = fakeFeatures({});
        const answer = await launcherToolchain(() => f.features).call('state', []) as Rows;
        expect(answer.rows.map((r) => r.tool)).toEqual(['node', 'claude-code']);
        expect(answer.rows[0]).toMatchObject({ tool: 'node', label: 'Node', installed: '24.10.0', to: '24.11.1', tone: 'update-available' });
        expect(answer.rows[1]).toMatchObject({ tool: 'claude-code', label: 'Claude Code', installed: '2.1.3', to: '2.1.5', tone: 'security-update', advisory: 'CVE-2026-0001: update to 2.1.5' });
        expect(answer.checkedAt).toBe(1_700_000_000_000);
        expect(answer.checking).toBe(false);
    });

    it('asks as the launcher’s own feature caller: the local owner, one caller for every link it opens', async () => {
        const f = fakeFeatures({});
        await launcherToolchain(() => f.features).call('state', []);
        expect(f.snaps[0]).toMatchObject({ connectionId: LAUNCHER_FEATURE_CALLER, isOwner: true, workspaceId: null, readonly: false });
        expect(f.acts).toEqual([]);
    });

    it('what a row is doing now: updating (its step), a warning to confirm, a refusal, the version it was updated to', async () => {
        const f = fakeFeatures({
            updating: { tool: 'node', version: '24.11.1', step: 'Downloading' },
            warning: { tool: 'claude-code', reason: '2 agents run on Claude Code; they are drained and started again.', affected: ['Researcher', 'Builder'] },
        });
        const rows = (await launcherToolchain(() => f.features).call('state', []) as Rows).rows;
        expect(rows.find((r) => r.tool === 'node')).toMatchObject({ updating: 'Downloading' });
        expect(rows.find((r) => r.tool === 'claude-code')).toMatchObject({ warning: '2 agents run on Claude Code; they are drained and started again.' });
        const g = fakeFeatures({ refusals: [{ tool: 'node', reason: 'the download did not match its checksum' }], updated: { tool: 'claude-code', version: '2.1.5' } });
        const after = (await launcherToolchain(() => g.features).call('state', []) as Rows).rows;
        expect(after.find((r) => r.tool === 'node')).toMatchObject({ refused: 'the download did not match its checksum' });
        expect(after.find((r) => r.tool === 'claude-code')).toMatchObject({ updated: '2.1.5' });
    });

    it('a host that has not scanned its tools yet says so with no rows; a host with no toolchain refuses', async () => {
        const f = fakeFeatures(null);
        expect(await launcherToolchain(() => f.features).call('state', [])).toEqual({ rows: [], checkedAt: null, checking: false });
        await expect(launcherToolchain(() => null).call('state', [])).rejects.toThrow('This host has no toolchain yet.');
    });
});

describe('the launcher asks the host to check and to install (never installs itself)', () => {
    it('check runs the host’s own scan, forced, and answers the rows', async () => {
        const f = fakeFeatures({});
        const answer = await launcherToolchain(() => f.features).call('check', []) as Rows;
        expect(f.acts.map((a) => a.action)).toEqual([{ kind: 'toolchain.check', force: true }]);
        expect(answer.rows.map((r) => r.tool)).toEqual(['node', 'claude-code']);
    });

    it('update is the host’s toolchain.update at the row’s version, answered once it has started, not when it ends', async () => {
        const f = fakeFeatures({}, { slowAct: true });
        const answer = await launcherToolchain(() => f.features).call('update', [{ tool: 'node' }]);
        expect(answer).toEqual({ started: true, tool: 'node', version: '24.11.1' });
        expect(f.acts.map((a) => a.action)).toEqual([{ kind: 'toolchain.update', tool: 'node', version: '24.11.1' }]);
        expect(f.acts[0]!.context.connectionId).toBe(LAUNCHER_FEATURE_CALLER);
        f.finish();
    });

    it('a confirmed update (the warning’s Update anyway) says so; a version asked for is the one installed', async () => {
        const f = fakeFeatures({});
        await launcherToolchain(() => f.features).call('update', [{ tool: 'node', version: '25.1.0', confirmed: true }]);
        expect(f.acts[0]!.action).toEqual({ kind: 'toolchain.update', tool: 'node', version: '25.1.0', confirmed: true });
    });

    it('a tool with no update on offer is refused, and nothing is asked of the installer', async () => {
        const f = fakeFeatures({});
        await expect(launcherToolchain(() => f.features).call('update', [{ tool: 'git' }])).rejects.toThrow('git has no update to install.');
        await expect(launcherToolchain(() => f.features).call('update', [{}])).rejects.toThrow('update needs {tool}');
        expect(f.acts).toEqual([]);
    });

    it('nothing else is the launcher’s to ask', async () => {
        await expect(launcherToolchain(() => fakeFeatures({}).features).call('install', [{ tool: 'php' }])).rejects.toThrow('Genie’s launcher may not ask the toolchain for install.');
    });
});

describe('the launcher’s link to the host’s toolchain', () => {
    it('engine.toolchain is an engine method the launcher’s link may call', () => {
        expect(ENGINE_METHODS).toContain('engine.toolchain');
        expect(LAUNCHER_LINK_METHODS).toContain('engine.toolchain');
    });

    it('wired: the server answers it from the host’s toolchain for a local link; genie-host gives it its features', () => {
        expect(src('src/main/session-engine-server.ts')).toMatch(/case 'engine\.toolchain':\n\s*if \(!this\.#options\.toolchain\)/);
        expect(src('src/main/genie-host.ts')).toMatch(/toolchain: launcherToolchain\(\(\) => hostFeatures\)/);
    });
});
