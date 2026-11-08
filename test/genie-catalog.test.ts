import { describe, expect, it } from 'vitest';
import { Catalog, validateDefinition } from '../src/core/catalog.js';
import { OFFICIAL_PLUGINS } from '../src/core/official-plugins.js';
import { BUILTIN_TOOLS, builtinToolPackage, genieCatalog, pluginPackage } from '../src/main/genie-catalog.js';
import { allGenieTools, type AllToolsDeps } from '../src/main/mcp-registrations.js';
import { parseManifest } from '../src/core/plugins.js';

/**
 * ADF A2 (Tynn #446; spec .ai/plans/specs/adf-sdk.md, story A2): BUILTINS THROUGH THE SAME PATH. The 18 builtin MCP tools
 * and the five official plugins (Document, Spreadsheet, Presentation, Repository, ArtBoard) register as catalog
 * definitions through A1's validator — the one a plugin goes through — and `allGenieTools` offers what the catalog
 * holds. A wrapper around the old hand-composed list does not count: a tool the catalog does not hold is not offered,
 * whatever module could run it.
 */

/** Today's list, every part present (normal Genie): 18 builtin tools (Genie Mail's `mail` since G6, Tynn #492), then the three official plugin tools. */
const TODAY = [
    'imDone', 'ForceTheQuestion', 'agentinbox', 'lists', 'thumbsUp', 'checkIssues', 'knowledge', 'manageTerminals', 'openFileForUser', 'plan',
    'services', 'sites', 'processes', 'flows', 'mail', 'createAgent', 'workspaceTabs', 'pages',
    'ai.genie.spreadsheet.createWorkbook', 'ai.genie.presentation.createDeck', 'ai.genie.artboard.post',
];

describe('the catalog alone lists today’s MCP tools', () => {
    it('exactly today’s 21 names, in today’s order — from the catalog, with no tool module and no deps', () => {
        const names = genieCatalog().list('tool').map((d) => d.id);
        expect(names).toEqual(TODAY);
        expect(names).toHaveLength(21);
    });

    it('the five official plugins are there whole: their editors and panels too, each in its own package', () => {
        const catalog = genieCatalog();
        expect(catalog.packages().map((p) => p.id)).toEqual(['ai.genie.core', 'ai.genie.document', 'ai.genie.spreadsheet', 'ai.genie.presentation', 'ai.genie.repository', 'ai.genie.artboard']);
        expect(catalog.list('editor').map((d) => d.id)).toEqual(['ai.genie.document.document', 'ai.genie.spreadsheet.sheet', 'ai.genie.presentation.deck']);
        expect(catalog.list('panel').map((d) => d.id)).toEqual(['ai.genie.repository.changes', 'ai.genie.artboard.board']);
        expect(catalog.get('ai.genie.spreadsheet.sheet')?.payload).toMatchObject({ extensions: ['.xlsx', '.csv', '.ods'], fancyEditor: 'SheetWorkbook' });
        expect(catalog.packages().every((p) => p.source === 'builtin')).toBe(true);
        expect(catalog.revision).toBe(6);
    });

    it('CONTROL: there are 18 builtin tool declarations and three official plugin tools (18 + 3 = 21)', () => {
        expect(BUILTIN_TOOLS).toHaveLength(18);
        const official = OFFICIAL_PLUGINS.flatMap((p) => ((p.manifest.mcpTools as unknown[] | undefined) ?? []));
        expect(official).toHaveLength(3);
    });
});

describe('a builtin goes through the same validator as a plugin', () => {
    const badSchema = { name: 'brokenTool', title: 'Broken', description: 'A builtin with an invalid schema.', inputSchema: { type: 'string' } };

    it('a builtin with an invalid schema is refused, and the catalog will not start with it', () => {
        expect(() => genieCatalog({ builtins: [...BUILTIN_TOOLS, badSchema] })).toThrow(/brokenTool.*inputSchema/);
    });

    it('the refusal is the validator’s own, word for word, as a plugin’s identical tool gets it', () => {
        const asBuiltin = new Catalog().register(builtinToolPackage([badSchema]));
        const manifest = parseManifest({ id: 'com.example.broken', name: 'Broken', version: '1.0.0', publisher: { name: 'Ex', keyId: 'k' }, mcpTools: [{ name: 'brokenTool', description: 'x', inputSchema: { type: 'object' }, run: 'a.js', process: 'worker', gated: false }] });
        expect(manifest.ok).toBe(true);
        if (!manifest.ok || asBuiltin.ok) throw new Error('setup');
        const pkg = pluginPackage(manifest.manifest, 'plugin');
        // The plugin's tool made the same way bad: the same validator, the same words for the same fault.
        const bad = { ...pkg, contributions: pkg.contributions.map((c) => ({ ...c, payload: { ...c.payload, inputSchema: { type: 'string' } } })) };
        const asPlugin = new Catalog().register(bad);
        expect(asPlugin.ok).toBe(false);
        const words = (problems: string[]) => problems.map((p) => p.replace(/^"[^"]+": /, ''));
        if (!asPlugin.ok) expect(words(asPlugin.problems)).toEqual(words(asBuiltin.problems));
        const direct = validateDefinition(builtinToolPackage([badSchema]).contributions[0]);
        expect(direct.ok).toBe(false);
    });

    it('CONTROL: every builtin declaration passes the validator on its own', () => {
        for (const c of builtinToolPackage(BUILTIN_TOOLS).contributions) expect(validateDefinition(c).ok, String((c as { id: string }).id)).toBe(true);
    });
});

// ------------------------------------------------------------------ allGenieTools reads the catalog
function deps(pluginTools: AllToolsDeps['plugins']['plugins']['tools'] = () => []): AllToolsDeps {
    const never = () => { throw new Error('not exercised'); };
    return {
        genie: { inbox: never as never, attention: never as never, roster: () => [], resolveCaller: () => null, userActive: () => true, glow: () => false, thumbsUp: () => {} },
        more: { knowledge: never as never, terminals: never as never, approve: async () => 'denied', resolveCaller: () => null },
        attention: { resolveCaller: () => null, openFile: async () => ({ ok: false, reason: 'x' }) },
        hosting: { resolveCaller: () => null, approve: async () => 'denied', services: null },
        processes: { resolveCaller: () => null, approve: async () => 'denied', processes: null },
        flows: { resolveCaller: () => null, flows: null },
        plugins: { plugins: { tools: pluginTools, guard: () => null }, run: never as never, approve: async () => 'denied', resolveCaller: () => null },
    };
}

describe('allGenieTools offers what the catalog holds', () => {
    it('a tool the catalog does not hold is NOT offered, though its module could run it', () => {
        const without = genieCatalog({ builtins: BUILTIN_TOOLS.filter((t) => t.name !== 'lists') });
        const names = allGenieTools(deps(), without).map((r) => r.definition.name);
        expect(names).not.toContain('lists');
        expect(names).toContain('thumbsUp');
    });

    it('CONTROL: with the whole catalog every builtin part offered today is offered, in the catalog’s order', () => {
        const names = allGenieTools(deps()).map((r) => r.definition.name);
        expect(names).toEqual(TODAY.slice(0, 14));
    });

    it('what goes out is what the catalog says: each offered tool’s description, title and schema are its definition’s', () => {
        const catalog = genieCatalog();
        for (const r of allGenieTools(deps(), catalog)) {
            const d = catalog.get(r.definition.name)!;
            const def = r.definition as unknown as { description: string; title?: string; inputSchema: unknown };
            expect(def.description).toBe(d.docs.description);
            expect(def.title).toBe(d.docs.name);
            expect(def.inputSchema).toEqual(d.payload.inputSchema);
        }
    });

    it('an enabled official plugin tool is offered from its catalog definition; a disabled one is not', () => {
        const spreadsheet = OFFICIAL_PLUGINS.find((p) => p.manifest.id === 'ai.genie.spreadsheet')!;
        const parsed = parseManifest(spreadsheet.manifest);
        if (!parsed.ok) throw new Error(parsed.reason);
        const ref = { pluginId: 'ai.genie.spreadsheet', dir: '', manifest: parsed.manifest, tool: parsed.manifest.mcpTools[0]!, official: true };
        expect(allGenieTools(deps(() => [ref])).map((r) => r.definition.name)).toContain('ai.genie.spreadsheet.createWorkbook');
        expect(allGenieTools(deps(() => [])).map((r) => r.definition.name)).not.toContain('ai.genie.spreadsheet.createWorkbook');
    });

    it('an external plugin registers as its own package; one that does not validate offers nothing', () => {
        const manifest = { id: 'acme.lint', name: 'Acme Lint', version: '1.0.0', publisher: { name: 'Acme', keyId: 'k' }, mcpTools: [], capabilities: { network: { hosts: [] }, genieApi: [] }, panels: [] };
        const tool = { name: 'lint', description: 'Lint', inputSchema: { type: 'object' }, run: 'tools/lint.js', process: 'subprocess' as const, gated: false };
        const good = allGenieTools(deps(() => [{ pluginId: 'acme.lint', dir: '/p', manifest: { ...manifest, mcpTools: [tool] }, tool }])).map((r) => r.definition.name);
        expect(good.at(-1)).toBe('acme.lint.lint');
        // A plugin presenting itself as an official package is refused whole: it cannot replace a builtin package, and
        // its handler never answers for the official tool's name.
        const thief = { ...tool, name: 'post' };
        const posing = { pluginId: 'ai.genie.artboard', dir: '/p', manifest: { ...manifest, id: 'ai.genie.artboard', mcpTools: [thief] }, tool: thief };
        expect(allGenieTools(deps(() => [posing])).map((r) => r.definition.name)).not.toContain('ai.genie.artboard.post');
        const catalog = genieCatalog();
        expect(catalog.register(pluginPackage(posing.manifest, 'plugin'))).toMatchObject({ ok: false });
        expect(catalog.get('ai.genie.artboard.post')?.source).toBe('builtin');
    });
});
