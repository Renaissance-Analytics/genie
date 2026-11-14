import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Catalog } from '../src/core/catalog.js';
import { catalogEditors, catalogFlowKinds, catalogFlowTools, catalogPanels } from '../src/core/catalog-projections.js';
import { builtinFlowPackage } from '../src/core/builtin-flow-nodes.js';
import { isSupportedKind, setOfferedFlowKinds, SUPPORTED_KINDS } from '../src/core/flow-canvas.js';
import { OFFICIAL_PLUGINS } from '../src/core/official-plugins.js';
import { parseManifest } from '../src/core/plugins.js';
import { genieCatalog, hostCatalog, pluginPackage } from '../src/main/genie-catalog.js';
import { FLOW_TOOLS } from '../src/main/flow-tools.js';

/**
 * ADF A5 (Tynn #449; spec .ai/plans/specs/adf-sdk.md, story A5): THE PROJECTIONS READ THE CATALOG. Which editor opens a
 * file, which panels a workspace offers and which steps the flow palette offers are each the catalog's elements of that
 * kind — never a list kept beside it. So disabling a package takes its editor, its panel and its flow node away TOGETHER,
 * because they leave the catalog together. The window keeps only its vetted compiled Fancy adapters.
 */

const code = (path: string) => readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('no list outside the catalog defines what is offered', () => {
    it('the flow palette’s step kinds and its tool steps are not handwritten lists', () => {
        expect(code('src/core/flow-canvas.ts')).not.toMatch(/SUPPORTED_KINDS: readonly string\[\] = \[/);
        expect(code('src/main/flow-tools.ts')).not.toMatch(/FLOW_TOOLS: readonly string\[\] = \[/);
    });

    it('the editors and panels a window is given are the catalog’s, not the plugin host’s own lists', () => {
        const ipc = code('src/main/feature-ipc.ts');
        const machine = code('src/main/feature-machine.ts');
        expect(ipc).toMatch(/\.\.\.machineFeatureSnapshot\(services, state, ports\)/);
        expect(code('src/main/features-host.ts')).toMatch(/machineFeatureSnapshot\(this\.#machine, state, this\.ports\.machine!\.effects\)/);
        for (const source of [ipc, machine]) {
            expect(source).not.toMatch(/services\.plugins\.editors\(\)/);
            expect(source).not.toMatch(/services\.plugins\.panels\(\)/);
        }
        expect(machine).toMatch(/editors: catalogEditors\(services\.catalogDefinitions\(\)\)/);
        expect(machine).toMatch(/panels: catalogPanels\(services\.catalogDefinitions\(\)\)/);
    });

    it('the flow steps Genie offers are in the catalog, as flow-node elements of their own package (26: 16 steps + 10 tools)', () => {
        const flows = genieCatalog().list('flow-node');
        expect(flows).toHaveLength(26);
        expect(new Set(flows.map((d) => d.packageId))).toEqual(new Set(['ai.genie.flows']));
        expect([...SUPPORTED_KINDS].sort()).toEqual(catalogFlowKinds(flows).filter((k) => !k.startsWith('@genie/')).sort());
        expect([...FLOW_TOOLS].sort()).toEqual(['ForceTheQuestion', 'agentinbox', 'checkIssues', 'imDone', 'knowledge', 'manageTerminals', 'openFileForUser', 'processes', 'services', 'sites']);
    });
});

describe('the projections are the catalog’s elements of a kind', () => {
    it('editors and panels as the window draws them, from Genie’s catalog', () => {
        const c = genieCatalog();
        expect(catalogEditors(c.list()).map((e) => `${e.pluginId}.${e.id}:${e.fancyEditor.export}`)).toEqual([
            'ai.genie.document.document:Editor', 'ai.genie.spreadsheet.sheet:SheetWorkbook', 'ai.genie.presentation.deck:DeckEditor',
        ]);
        expect(catalogEditors(c.list())[1]).toMatchObject({ title: 'Sheets', pluginName: 'Spreadsheet', extensions: ['.xlsx', '.csv', '.ods'] });
        expect(catalogPanels(c.list()).map((p) => `${p.pluginId}.${p.id}:${p.fancyComponent.export}`)).toEqual(['ai.genie.repository.changes:RepoChangesPanel', 'ai.genie.artboard.board:ArtBoardPanel']);
    });

    it('the flow palette offers what the catalog says, and follows it when it changes', () => {
        const kinds = catalogFlowKinds(genieCatalog().list());
        setOfferedFlowKinds(kinds);
        expect(isSupportedKind('genie/agent_prompt')).toBe(true);
        setOfferedFlowKinds(kinds.filter((k) => k !== 'genie/agent_prompt'));
        expect(isSupportedKind('genie/agent_prompt')).toBe(false);
        setOfferedFlowKinds(kinds);
        expect(isSupportedKind('genie/agent_prompt')).toBe(true);
    });
});

describe('disabling a package takes its editor, its panel and its flow node away together', () => {
    const bundle = {
        id: 'com.example.bundle', version: '1.0.0', source: 'plugin' as const,
        contributions: [
            { id: 'com.example.bundle.ed', kind: 'editor', payload: { title: 'Ed', extensions: ['.ex'], fancyEditor: 'Editor', pluginName: 'Bundle' } },
            { id: 'com.example.bundle.pane', kind: 'panel', payload: { title: 'Pane', fancyComponent: 'Callout', props: {}, pluginName: 'Bundle' } },
            { id: 'com.example.bundle.step', kind: 'flow-node', payload: { executor: 'com.example/step' } },
        ].map((c) => ({
            ...c, version: '1.0.0', packageId: 'com.example.bundle', source: 'plugin',
            docs: { name: c.id, description: 'x' },
            // An editor runs on both sides, with its link (the owner's ruling q_d71981d6); the panel and the step on a client.
            reach: c.kind === 'editor'
                ? { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'allowed', link: { calls: ['files.readBytes', 'files.writeBytes'], events: [] } }
                : { scopes: ['workspace'], side: 'client', requiresWindow: true, remote: 'allowed' },
            permissions: { capabilities: [], network: [] },
        })),
    };

    it('registered, all three are offered; unregistered (disabled), none of them is', () => {
        const c = genieCatalog();
        expect(c.register(bundle).ok).toBe(true);
        expect(catalogEditors(c.list()).some((e) => e.pluginId === 'com.example.bundle')).toBe(true);
        expect(catalogPanels(c.list()).some((p) => p.pluginId === 'com.example.bundle')).toBe(true);
        expect(catalogFlowKinds(c.list())).toContain('com.example/step');
        expect(c.unregister('com.example.bundle').ok).toBe(true);
        expect(catalogEditors(c.list()).some((e) => e.pluginId === 'com.example.bundle')).toBe(false);
        expect(catalogPanels(c.list()).some((p) => p.pluginId === 'com.example.bundle')).toBe(false);
        expect(catalogFlowKinds(c.list())).not.toContain('com.example/step');
    });

    it('a DISABLED official plugin is out of the host’s catalog: its editor and panel go (CONTROL: enabled, they are there)', () => {
        const manifestOf = (id: string) => { const p = parseManifest(OFFICIAL_PLUGINS.find((o) => o.manifest.id === id)!.manifest); if (!p.ok) throw new Error(p.reason); return p.manifest; };
        const plugins = (disabled: string[]) => {
            const ids = OFFICIAL_PLUGINS.map((o) => String(o.manifest.id));
            return {
                tools: () => [],
                manifests: () => Object.fromEntries(ids.map((id) => [id, manifestOf(id)])),
                list: () => ids.map((id) => ({ id, state: disabled.includes(id) ? 'disabled' : 'enabled', official: true })),
            };
        };
        const on = hostCatalog(plugins([]));
        expect(catalogEditors(on.list()).map((e) => e.pluginId)).toContain('ai.genie.spreadsheet');
        expect(catalogPanels(on.list()).map((p) => p.pluginId)).toContain('ai.genie.artboard');
        const off = hostCatalog(plugins(['ai.genie.spreadsheet', 'ai.genie.artboard']));
        expect(catalogEditors(off.list()).map((e) => e.pluginId)).not.toContain('ai.genie.spreadsheet');
        expect(catalogPanels(off.list()).map((p) => p.pluginId)).not.toContain('ai.genie.artboard');
        expect(off.get('ai.genie.spreadsheet.createWorkbook')).toBeNull();
    });
});

describe('CONTROL: what the catalog projects passes its validator', () => {
    it('the flow package registers on its own', () => {
        expect(new Catalog().register(builtinFlowPackage())).toMatchObject({ ok: true });
        expect(catalogFlowTools(builtinFlowPackage().contributions as never)).toHaveLength(10);
    });

    it('a plugin’s editor carries its plugin’s name for the window', () => {
        const p = parseManifest(OFFICIAL_PLUGINS[0]!.manifest);
        if (!p.ok) throw new Error(p.reason);
        expect(pluginPackage(p.manifest, 'builtin').contributions.find((c) => c.kind === 'editor')?.payload).toMatchObject({ pluginName: 'Document' });
    });
});

/**
 * PROJECTED BY SIDE (the owner's ruling q_d71981d6: every element declares where it runs). A window's editors and panels
 * are the elements a client draws: `client`, or `both` with their link. An element that runs on the host alone is never
 * offered to a window, whatever its kind.
 */
describe('a window is offered what runs on a client', () => {
    const sheet = genieCatalog().get('ai.genie.spreadsheet.sheet')!;
    const board = genieCatalog().get('ai.genie.artboard.board')!;
    const on = <T extends { reach: object }>(d: T, side: string) => ({ ...d, reach: { ...d.reach, side } });

    it('a host-only editor or panel is not projected (CONTROL: on a client, or both, it is)', () => {
        expect(catalogEditors([on(sheet, 'host')] as never)).toEqual([]);
        expect(catalogPanels([on(board, 'host')] as never)).toEqual([]);
        expect(catalogEditors([on(sheet, 'both')] as never).map((e) => e.id)).toEqual(['sheet']);
        expect(catalogPanels([on(board, 'client')] as never).map((p) => p.id)).toEqual(['board']);
    });
});
