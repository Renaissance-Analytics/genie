import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog } from '../src/core/catalog.js';
import { parseManifest } from '../src/core/plugins.js';
import { genieCatalog, pluginPackage } from '../src/main/genie-catalog.js';

/**
 * ADF B1 (Tynn #451; spec .ai/plans/specs/adf-sdk.md, story B1): GENIE 1'S MANIFESTS PARSE AND REGISTER. Genie 1's
 * `genie-plugin.json` (main/plugins/manifest.ts at v0.7.0-beta.342) is normalized by the one parser into today's
 * manifest: its `contributes {}` block and its top-level arrays, `namespace` (the tool prefix again, with the
 * `<id>.<tool>` name kept as an alias, decision 2), `entry.tools` (a tool's `run` names an entry), `agent.guide`
 * (carried into each tool's description), optional `run` / `process` / `gated` (Genie 1's defaults), `description`,
 * editors' `toolbarActions`, panels' `icon` and `placement`, and `fs.scope: "none"`. Still strict: an unknown key is
 * refused, and so is declaring surfaces both in `contributes` and at the top level (Genie 1's own rule).
 *
 * The fixture is Genie 1's hello-world, copied byte for byte: test/fixtures/genie1-plugins/hello-world/genie-plugin.json.
 */
const HELLO = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'genie1-plugins', 'hello-world', 'genie-plugin.json'), 'utf8')) as Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('Genie 1\'s hello-world plugin', () => {
    it('parses: its namespace, description, entry, agent guide and tool defaults are read', () => {
        const parsed = parseManifest(HELLO);
        if (!parsed.ok) throw new Error(`refused: ${parsed.reason}`);
        const m = parsed.manifest;
        expect(m).toMatchObject({ id: 'ai.genie.hello-world', namespace: 'hello', name: 'Hello World', version: '0.1.0', description: expect.stringContaining('trivial dev plugin') });
        expect(m.publisher).toEqual({ name: 'Genie', url: 'https://github.com/Renaissance-Analytics/genie' });
        expect(m.agent).toEqual({ guide: expect.stringContaining('hello.greet') });
        expect(m.mcpTools).toEqual([expect.objectContaining({ name: 'greet', run: 'tools.cjs', process: 'worker', gated: false })]);
        // fs.scope "none" is no file access at all.
        expect(m.capabilities.fs).toBeUndefined();
    });

    it('registers: its tool is `hello.greet`, its `<id>.greet` name an alias, the agent guide in its description', () => {
        const parsed = parseManifest(HELLO);
        if (!parsed.ok) throw new Error(parsed.reason);
        const catalog = genieCatalog();
        const before = catalog.revision;
        const r = catalog.register(pluginPackage(parsed.manifest, 'plugin'));
        expect(r.ok).toBe(true);
        expect(catalog.revision).toBe(before + 1);
        const tool = catalog.get('hello.greet');
        expect(tool).toMatchObject({ id: 'hello.greet', kind: 'tool', packageId: 'ai.genie.hello-world', source: 'plugin', aliases: ['ai.genie.hello-world.greet'] });
        expect(catalog.get('ai.genie.hello-world.greet')?.id).toBe('hello.greet');
        expect(String(tool!.docs.description)).toContain('Return a friendly greeting');
        expect(String(tool!.docs.description)).toContain('Use hello.greet when the user asks for a greeting');
        expect(tool!.payload).toMatchObject({ handler: 'hello.greet', process: 'worker', gated: false });
    });
});

describe('the `contributes {}` form, as Genie 1 wrote it', () => {
    const contributed = () => {
        const m = clone(HELLO);
        m.contributes = { mcpTools: m.mcpTools, editors: m.editors };
        delete m.mcpTools;
        delete m.editors;
        return m;
    };

    it('parses to the same manifest as the top-level form', () => {
        const a = parseManifest(HELLO);
        const b = parseManifest(contributed());
        expect(b.ok).toBe(true);
        if (!a.ok || !b.ok) throw new Error('setup');
        expect(b.manifest.mcpTools).toEqual(a.manifest.mcpTools);
        expect(b.manifest.editors).toEqual(a.manifest.editors);
    });

    it('surfaces in BOTH places are refused, naming the key (declare them in one place)', () => {
        const both = contributed();
        both.mcpTools = HELLO.mcpTools;
        const r = parseManifest(both);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/mcpTools.*inside `contributes`/);
    });

    it('recipes are accepted with the `recipes` Genie API declared, and refused without it (Genie 1\'s rule; they run from B3)', () => {
        const recipe = { id: 'setup', title: 'Set up', steps: [{ type: 'form', id: 'f', title: 'Your key', fields: [{ key: 'apiKey', label: 'API key', type: 'password' }] }] };
        const withCap = clone(HELLO);
        withCap.contributes = { recipes: [recipe] };
        withCap.capabilities.genieApi = ['recipes'];
        const ok = parseManifest(withCap);
        expect(ok.ok).toBe(true);
        if (ok.ok) expect(ok.manifest.recipes).toEqual([recipe]);
        const without = clone(withCap);
        without.capabilities.genieApi = [];
        const refused = parseManifest(without);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.reason).toMatch(/"recipes"/);
    });

    it('a recipe step Genie 1 could not serialize (`task`) is refused', () => {
        const m = clone(HELLO);
        m.contributes = { recipes: [{ id: 'r', title: 'R', steps: [{ type: 'task', id: 't', title: 'T' }] }] };
        m.capabilities.genieApi = ['recipes'];
        const r = parseManifest(m);
        expect(r.ok).toBe(false);
    });

    it('the reserved kinds (flyouts, modals, wizards, the two pages) are accepted as declared and kept, not run', () => {
        const m = clone(HELLO);
        const ref = { package: '@particle-academy/react-fancy', version: '1.0.0', export: 'Callout' };
        m.contributes = { flyouts: [{ id: 'f', title: 'F', fancyComponent: ref }], modals: [], wizards: [], workstationPage: { fancyComponent: ref } };
        const r = parseManifest(m);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.manifest.reserved).toMatchObject({ flyouts: [{ id: 'f' }], workstationPage: { fancyComponent: ref } });
        const bad = clone(HELLO);
        bad.contributes = { flyouts: { not: 'a list' } };
        expect(parseManifest(bad).ok).toBe(false);
    });
});

describe('Genie 1\'s optional fields', () => {
    it('a tool with no run, process or gated: Genie 1\'s defaults (entry.tools, worker, not gated)', () => {
        const m = clone(HELLO);
        delete m.mcpTools[0].run;
        delete m.mcpTools[0].process;
        delete m.mcpTools[0].gated;
        const r = parseManifest(m);
        if (!r.ok) throw new Error(r.reason);
        expect(r.manifest.mcpTools[0]).toMatchObject({ run: 'tools.cjs', process: 'worker', gated: false });
    });

    it('a tool whose run names no entry, and no module path either, is refused naming the entry it needs', () => {
        const m = clone(HELLO);
        delete m.entry;
        delete m.mcpTools[0].run;
        const r = parseManifest(m);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/entry\.tools/);
    });

    it('editors keep their toolbarActions; panels their icon and placement — into the catalog', () => {
        const m = clone(HELLO);
        m.capabilities.genieApi = ['ui.panel'];
        m.editors = [{ id: 'deck', title: 'Deck', extensions: ['.pptx'], fancyEditor: { package: '@particle-academy/fancy-slides', version: '1.0.0', export: 'DeckEditor' }, toolbarActions: [{ id: 'present', title: 'Present', icon: 'play', mode: 'present' }] }];
        m.panels = [{ id: 'board', title: 'Board', icon: 'layout', placement: 'workspace', fancyComponent: { package: '@particle-academy/react-fancy', version: '1.0.0', export: 'Callout' } }];
        const r = parseManifest(m);
        if (!r.ok) throw new Error(r.reason);
        expect(r.manifest.editors?.[0]?.toolbarActions).toEqual([{ id: 'present', title: 'Present', icon: 'play', mode: 'present' }]);
        expect(r.manifest.panels[0]).toMatchObject({ icon: 'layout', placement: 'workspace' });
        const catalog = new Catalog();
        expect(catalog.register(pluginPackage(r.manifest, 'plugin')).ok).toBe(true);
        expect(catalog.get('ai.genie.hello-world.deck')?.payload).toMatchObject({ toolbarActions: [{ id: 'present' }] });
        expect(catalog.get('ai.genie.hello-world.board')?.payload).toMatchObject({ icon: 'layout', placement: 'workspace' });
    });

    it('a panel placement Genie 1 did not have is refused', () => {
        const m = clone(HELLO);
        m.capabilities.genieApi = ['ui.panel'];
        m.panels = [{ id: 'board', title: 'Board', placement: 'sidebar', fancyComponent: { package: 'p', version: '1', export: 'Callout' } }];
        expect(parseManifest(m).ok).toBe(false);
    });

    it('still strict: a key no Genie ever had is refused by name', () => {
        const m = clone(HELLO);
        m.network = { anywhere: true };
        const r = parseManifest(m);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/unknown key "network"/);
    });

    it('a namespace that is not a slug is refused', () => {
        const m = clone(HELLO);
        m.namespace = 'Hello World';
        expect(parseManifest(m).ok).toBe(false);
    });

    it('CONTROL: a manifest with no namespace keeps today\'s tool names, `<id>.<tool>`, with no alias', () => {
        const m = clone(HELLO);
        delete m.namespace;
        const r = parseManifest(m);
        if (!r.ok) throw new Error(r.reason);
        const catalog = new Catalog();
        expect(catalog.register(pluginPackage(r.manifest, 'plugin')).ok).toBe(true);
        expect(catalog.get('ai.genie.hello-world.greet')).toMatchObject({ id: 'ai.genie.hello-world.greet', aliases: [] });
    });
});
