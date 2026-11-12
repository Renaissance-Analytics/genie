import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { composeServices } from './helpers/compose-alone.js';
import type { ComposedServices } from '../src/main/compose.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/*
 * Tynn #698 story 2, on the Toolchain: a Broken agent CLI offers ONE obvious action, Repair. It shows each step while it
 * runs, and ends repaired (what the check found after) or failed with the reason on the row, where Repair is offered again.
 */
const featureIpc = async () => { const path: string = '../src/main/feature-ipc.js'; return import(path) as Promise<any>; };

const BROKEN = { tool: 'claude-code', installed: null, latest: null, tone: 'broken', source: null, problem: 'Claude Code is installed but cannot run: npm installed it without running its setup step' };
const row = (html: string, tool: string) => html.slice(html.indexOf(`data-tool="${tool}"`), html.indexOf('</li>', html.indexOf(`data-tool="${tool}"`)));
const render = (toolchain: unknown) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain: toolchain as FeatureData['toolchain'] }} onAction={() => {}} onNavigate={() => {}} />);

describe('a Broken agent CLI row', () => {
    it('offers Repair, and no Install or Update', () => {
        const html = row(render({ tools: [BROKEN], checkedAt: 1 }), 'claude-code');
        expect(html).toContain('data-action="toolchain-repair-cli"');
        expect(html).toContain('Repair');
        expect(html).not.toContain('data-action="toolchain-update"');
        expect(html).not.toContain('>Install<');
    });

    it('shows the step while the repair runs, with its button busy', () => {
        const html = row(render({ tools: [BROKEN], checkedAt: 1, updating: { tool: 'claude-code', step: 'Running Claude Code’s installer' } }), 'claude-code');
        expect(html).toContain('Running Claude Code’s installer');
        expect(html).toContain('data-tool-updating="claude-code"');
    });
});

describe('the Repair action', () => {
    const pty: PtyPort = { open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
    let dir: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-toolchain-cli-repair-'));
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
    });

    const ports = (outcome: Record<string, unknown>, seen: { repairs: string[]; rows: unknown[]; probes: number }) => ({
        toolchain: {
            probe: async () => { seen.probes += 1; return [BROKEN]; },
            update: async () => ({ kind: 'refused', reason: 'no' }),
            now: () => 1,
            updating: (r: unknown) => { seen.rows.push(r); },
            repairCli: async (provider: string, progress: (step: string | null) => void) => { seen.repairs.push(provider); progress('Running Claude Code’s installer'); progress(null); return outcome; },
        },
    });
    const state = { toolStatuses: [BROKEN], knowledgeQuery: '', toolchainCheckedAt: 1 };

    it('runs the repair for the row\'s provider, pushes its steps, says the result, and rescans', async () => {
        const { handleFeatureAction } = await featureIpc();
        const seen = { repairs: [] as string[], rows: [] as unknown[], probes: 0 };
        const done = await handleFeatureAction(services, { kind: 'toolchain.repairCli', tool: 'claude-code' }, state, ports({ kind: 'repaired', version: '2.1.322', signedIn: true, words: 'Claude Code 2.1.322 is installed and answers.' }, seen));
        expect(seen.repairs).toEqual(['claude']);
        expect(seen.rows).toEqual([{ tool: 'claude-code', step: 'Starting' }, { tool: 'claude-code', step: 'Running Claude Code’s installer' }, null]);
        expect(done.toolchain?.result).toBe('Claude Code 2.1.322 is installed and answers.');
        expect(done.toolchain?.refusals).toBeUndefined();
        expect(seen.probes).toBe(1);
    });

    it('a failed repair is said on the row, in its own words', async () => {
        const { handleFeatureAction } = await featureIpc();
        const seen = { repairs: [] as string[], rows: [] as unknown[], probes: 0 };
        const done = await handleFeatureAction(services, { kind: 'toolchain.repairCli', tool: 'codex' }, state, ports({ kind: 'failed', reason: 'Codex’s installer failed: download refused' }, seen));
        expect(seen.repairs).toEqual(['codex']);
        expect(done.toolchain?.refusals).toEqual([{ tool: 'codex', reason: 'Codex’s installer failed: download refused' }]);
        expect(seen.rows.at(-1)).toBeNull();
    });

    it('a repair that throws still ends the row\'s step, and says why on it', async () => {
        const { handleFeatureAction } = await featureIpc();
        const rows: unknown[] = [];
        const throwing = { toolchain: { probe: async () => [BROKEN], update: async () => ({ kind: 'refused', reason: 'no' }), now: () => 1, updating: (r: unknown) => { rows.push(r); }, repairCli: async () => { throw new Error('spawn host is unreachable'); } } };
        const done = await handleFeatureAction(services, { kind: 'toolchain.repairCli', tool: 'claude-code' }, state, throwing);
        expect(rows.at(-1)).toBeNull();
        expect(done.toolchain?.refusals).toEqual([{ tool: 'claude-code', reason: expect.stringContaining('spawn host is unreachable') }]);
    });
});
