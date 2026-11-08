import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginManifest, PluginTool } from '../src/core/plugins.js';
import { pluginPaneState } from '../src/core/catalog-projections.js';
import { CatalogService } from '../src/main/catalog-host.js';
import { hostCatalog } from '../src/main/genie-catalog.js';
import { pluginTools, type PluginToolRef } from '../src/main/mcp-tools-plugins.js';
import { PluginsService } from '../src/main/plugins-host.js';

/**
 * ADF A6 (Tynn #450; spec .ai/plans/specs/adf-sdk.md, story A6): A PACKAGE'S LIFECYCLE. Enable, disable, update and
 * uninstall change what the catalog holds, whole; a call already running finishes (drains), a call made after is refused
 * with the reason, and NOTHING calls a handler its package no longer offers — an update runs the new one, never the old.
 * An open pane whose element is gone says it is unavailable, and why.
 */

const tool = (name: string): PluginTool => ({ name, description: `Run ${name}`, inputSchema: { type: 'object' }, run: 'tools/x.js', process: 'subprocess', gated: false });
const manifest = (version: string, tools: string[]): PluginManifest => ({
    id: 'acme.lint', name: 'Acme Lint', version, publisher: { name: 'Acme', keyId: 'k' },
    mcpTools: tools.map(tool), capabilities: { network: { hosts: [] }, genieApi: [] }, panels: [], editors: [],
});
const caller = { agentId: 'a1', agentName: 'atlas', workspaceId: 'w', workspacePath: '/w' };

/** The plugins as the host has them now: changeable, as enable / disable / update / uninstall change them. */
function plugins() {
    let installed: PluginManifest | null = manifest('1.0.0', ['lint']);
    const refs = (): PluginToolRef[] => (installed ? installed.mcpTools.map((t) => ({ pluginId: 'acme.lint', dir: '/p/acme', manifest: installed!, tool: t })) : []);
    const ran: string[] = [];
    let release: (() => void) | null = null;
    const registrations = pluginTools({
        plugins: { tools: refs, guard: (id) => (installed && id === 'acme.lint' ? () => ({ allowed: true }) : null) },
        run: async (input) => {
            ran.push(`${input.tool.name}@${input.manifest.version}`);
            await new Promise<void>((r) => { release = r; });
            return { ok: true, result: `${input.tool.name}@${input.manifest.version} done` };
        },
        approve: async () => 'allowed',
        resolveCaller: () => caller as never,
    });
    const call = (name: string) => registrations.find((r) => r.definition.name === name)!.handler({ terminalId: 't' } as never, { server: 'genie', tool: name, headers: {} } as never);
    return { set: (m: PluginManifest | null) => { installed = m; }, ran, call, finish: () => release?.() };
}

describe('a call already running when its package is disabled', () => {
    it('finishes (it drains); a call made after the disable is refused with the reason; the old handler is not called again', async () => {
        const p = plugins();
        const inFlight = p.call('acme.lint.lint');
        await new Promise((r) => setTimeout(r, 0));
        expect(p.ran).toEqual(['lint@1.0.0']);
        p.set(null); // disabled
        const after = await p.call('acme.lint.lint');
        expect(after.isError).toBe(true);
        expect(after.text).toMatch(/acme\.lint\.lint is unavailable/);
        p.finish();
        const done = await inFlight;
        expect(done.isError).toBe(false);
        expect(done.text).toContain('lint@1.0.0 done');
        expect(p.ran).toEqual(['lint@1.0.0']);
    });
});

describe('an update runs the NEW handler, never the one the tool list was built with', () => {
    it('after an update to 2.0.0 a call runs lint@2.0.0', async () => {
        const p = plugins();
        p.set(manifest('2.0.0', ['lint']));
        const r = p.call('acme.lint.lint');
        await new Promise((x) => setTimeout(x, 0));
        p.finish();
        await r;
        expect(p.ran).toEqual(['lint@2.0.0']);
    });

    it('a tool the update dropped is unavailable, by name', async () => {
        const p = plugins();
        p.set(manifest('2.0.0', ['fix']));
        const r = await p.call('acme.lint.lint');
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/acme\.lint\.lint is unavailable: acme\.lint 2\.0\.0 no longer offers it/);
        expect(p.ran).toEqual([]);
    });
});

describe('an open pane whose element is gone says it is unavailable, and why', () => {
    const entries = (state: string) => [{ id: 'ai.genie.artboard', name: 'ArtBoard', state }];
    const panels = [{ pluginId: 'ai.genie.artboard', id: 'board' }];

    it('available while its package offers it', () => {
        expect(pluginPaneState(panels, entries('enabled'), 'ai.genie.artboard', 'board')).toEqual({ available: true });
    });

    it('disabled, uninstalled, or no longer offered: each its own reason', () => {
        expect(pluginPaneState([], entries('disabled'), 'ai.genie.artboard', 'board')).toEqual({ available: false, reason: 'ArtBoard is turned off: turn it on in Settings, Plugins, or close this pane.' });
        expect(pluginPaneState([], [], 'ai.genie.artboard', 'board')).toEqual({ available: false, reason: 'ai.genie.artboard is not installed any more: close this pane.' });
        expect(pluginPaneState([], entries('enabled'), 'ai.genie.artboard', 'board')).toEqual({ available: false, reason: 'ArtBoard no longer offers this panel (board): close this pane.' });
    });
});

describe('on the host: update and uninstall', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-a6-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const writePlugin = async (version: string, tools: string[]) => {
        await mkdir(join(dir, 'plugins', 'acme-lint'), { recursive: true });
        await writeFile(join(dir, 'plugins', 'acme-lint', 'genie-plugin.json'), JSON.stringify({ ...manifest(version, tools), mcpTools: tools.map(tool) }));
    };

    it('an update replaces the package’s elements at one new revision: never half the old and half the new', async () => {
        await writePlugin('1.0.0', ['lint', 'fix']);
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, publisherChecksOff: () => true });
        const catalog = new CatalogService(() => hostCatalog(service.plugins()));
        const seen: Array<{ revision: number; versions: string[] }> = [];
        catalog.onEvent(() => {
            const snap = catalog.snapshot();
            seen.push({ revision: snap.revision, versions: [...new Set(snap.definitions.filter((d) => d.packageId === 'acme.lint').map((d) => d.version))] });
        });
        service.onEvent(() => catalog.rebuild());
        const before = catalog.snapshot().revision;
        await writePlugin('2.0.0', ['lint', 'check']);
        await service.call('refresh', []);
        expect(seen).toEqual([{ revision: before + 1, versions: ['2.0.0'] }]);
        const ids = catalog.snapshot().definitions.filter((d) => d.packageId === 'acme.lint').map((d) => d.id).sort();
        expect(ids).toEqual(['acme.lint.check', 'acme.lint.lint']);
    });

    it('uninstall removes an installed plugin’s folder and its elements; Genie’s own cannot be uninstalled', async () => {
        await writePlugin('1.0.0', ['lint']);
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, publisherChecksOff: () => true });
        expect(service.dump().entries.map((e) => e.id)).toContain('acme.lint');
        expect(await service.call('uninstall', ['acme.lint'])).toBe(true);
        expect(service.dump().entries.map((e) => e.id)).not.toContain('acme.lint');
        expect(await readdir(join(dir, 'plugins'))).not.toContain('acme-lint');
        await expect(service.call('uninstall', ['ai.genie.spreadsheet'])).rejects.toThrow(/ships with Genie/);
        expect(service.dump().entries.map((e) => e.id)).toContain('ai.genie.spreadsheet');
    });
});
