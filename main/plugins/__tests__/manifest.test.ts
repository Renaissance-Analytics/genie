import { describe, expect, it } from 'vitest';
import {
    validatePluginManifest,
    validateMarketplaceManifest,
    namespacedToolName,
    manifestContributions,
    PANEL_CAPABILITY,
    RECIPE_CAPABILITY,
    type PluginManifest,
} from '../manifest';

/** A minimal VALID plugin manifest (the hello-world shape). */
function validPlugin(): Record<string, unknown> {
    return {
        id: 'ai.genie.hello-world',
        namespace: 'hello',
        name: 'Hello World',
        version: '0.1.0',
        entry: { tools: 'tools.cjs' },
        agent: { guide: 'Use this plugin when a greeting is requested.' },
        mcpTools: [
            {
                name: 'greet',
                description: 'Return a greeting.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                run: 'tools',
                process: 'worker',
                gated: false,
            },
        ],
        capabilities: { fs: { scope: 'none' }, network: { hosts: [] }, genieApi: [] },
    };
}

describe('validatePluginManifest', () => {
    it('accepts a well-formed manifest', () => {
        const res = validatePluginManifest(validPlugin());
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.manifest.namespace).toBe('hello');
    });

    it('rejects MCP tools without an agent guide or skill', () => {
        const manifest = validPlugin();
        delete manifest.agent;
        const res = validatePluginManifest(manifest);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.errors).toContain('`agent.guide` is required when `mcpTools` are present');
        }
    });

    it('rejects an empty plugin guide', () => {
        const manifest = validPlugin();
        manifest.agent = { guide: '' };
        expect(validatePluginManifest(manifest).ok).toBe(false);
    });

    it('rejects a non-object', () => {
        expect(validatePluginManifest(null).ok).toBe(false);
        expect(validatePluginManifest('nope').ok).toBe(false);
    });

    it('requires id / namespace / name / version', () => {
        const res = validatePluginManifest({});
        expect(res.ok).toBe(false);
        if (!res.ok) {
            const joined = res.errors.join('\n');
            expect(joined).toContain('`id` is required');
            expect(joined).toContain('`namespace` is required');
            expect(joined).toContain('`name` is required');
            expect(joined).toContain('`version` is required');
        }
    });

    it('enforces reverse-DNS id, slug namespace, and semver version', () => {
        const res = validatePluginManifest({
            ...validPlugin(),
            id: 'NotReverseDNS',
            namespace: 'Bad Namespace',
            version: 'v1',
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            const joined = res.errors.join('\n');
            expect(joined).toContain('reverse-DNS');
            expect(joined).toContain('lowercase slug');
            expect(joined).toContain('semver');
        }
    });

    it('requires each tool to have a description, an object inputSchema, and an entry module', () => {
        const m = validPlugin();
        m.entry = {}; // no tools entry → the tool has nowhere to load from
        (m.mcpTools as Array<Record<string, unknown>>)[0].inputSchema = { type: 'array' };
        (m.mcpTools as Array<Record<string, unknown>>)[0].description = '';
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            const joined = res.errors.join('\n');
            expect(joined).toContain('inputSchema');
            expect(joined).toContain('description is required');
            expect(joined).toContain('entry.tools');
        }
    });

    it('rejects an invalid per-tool process value', () => {
        const m = validPlugin();
        (m.mcpTools as Array<Record<string, unknown>>)[0].process = 'thread';
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('process must be "worker" or "subprocess"');
    });

    it('flags duplicate tool names', () => {
        const m = validPlugin();
        m.mcpTools = [
            (m.mcpTools as unknown[])[0],
            (m.mcpTools as unknown[])[0],
        ];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('duplicated');
    });

    it('requires a DECLARED first-party Fancy editor mapping (§12.2), not a shipped bundle', () => {
        const m = validPlugin();
        m.editors = [
            {
                id: 'deck',
                title: 'Slides',
                extensions: ['.pptx'],
                // No fancyEditor → must fail (a plugin may only DECLARE a Fancy editor).
            },
        ];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('fancyEditor');
    });

    it('accepts a valid declared Fancy editor mapping', () => {
        const m = validPlugin();
        m.editors = [
            {
                id: 'deck',
                title: 'Slides',
                extensions: ['.pptx', '.odp'],
                fancyEditor: { package: 'fancy-slides', version: '^1.0.0', export: 'DeckEditor' },
                toolbarActions: [{ id: 'present', title: 'Present', icon: 'play', mode: 'fullscreen' }],
            },
        ];
        expect(validatePluginManifest(m).ok).toBe(true);
    });

    it('rejects editor extensions that are not dot-prefixed', () => {
        const m = validPlugin();
        m.editors = [
            {
                id: 'deck',
                title: 'Slides',
                extensions: ['pptx'],
                fancyEditor: { package: 'fancy-slides', version: '1.0.0', export: 'DeckEditor' },
            },
        ];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('dot-prefixed');
    });

    it('accepts signing-ready fields (integrity + publisher.keyId)', () => {
        const m = validPlugin();
        m.integrity = 'sha256-abc';
        m.publisher = { name: 'Particle Academy', url: 'https://x', keyId: 'key-1' };
        expect(validatePluginManifest(m).ok).toBe(true);
    });
});

describe('validateMarketplaceManifest', () => {
    function validMarket(): Record<string, unknown> {
        return {
            id: 'com.example.marketplace',
            name: 'Example Marketplace',
            plugins: [
                { id: 'com.example.alpha', name: 'Alpha', repo: 'https://github.com/x/alpha.git' },
                { id: 'com.example.beta', name: 'Beta', path: 'plugins/beta' },
            ],
        };
    }

    it('accepts a well-formed marketplace index', () => {
        const res = validateMarketplaceManifest(validMarket());
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.manifest.plugins).toHaveLength(2);
    });

    it('requires a plugins array', () => {
        const res = validateMarketplaceManifest({ id: 'com.example.m', name: 'M' });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('`plugins` is required');
    });

    it('requires each member to be locatable (repo OR path)', () => {
        const m = validMarket();
        m.plugins = [{ id: 'com.example.alpha', name: 'Alpha' }];
        const res = validateMarketplaceManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('either `repo`');
    });

    it('flags duplicate member ids', () => {
        const m = validMarket();
        m.plugins = [
            { id: 'com.example.alpha', name: 'A', repo: 'https://x/a.git' },
            { id: 'com.example.alpha', name: 'A2', repo: 'https://x/a2.git' },
        ];
        const res = validateMarketplaceManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('duplicated');
    });
});

describe('namespacedToolName', () => {
    it('joins namespace + tool with a dot', () => {
        expect(namespacedToolName('hello', 'greet')).toBe('hello.greet');
    });
});

/** A minimal VALID recipe-contributing plugin (declarative steps only). */
function validRecipePlugin(): Record<string, unknown> {
    return {
        id: 'com.example.deployer',
        namespace: 'deployer',
        name: 'Deployer',
        version: '1.0.0',
        // Contributing recipes REQUIRES the grantable `recipes` Genie-API permission.
        capabilities: { genieApi: ['recipes'] },
        recipes: [
            {
                id: 'deploy',
                title: 'Deploy',
                steps: [
                    { type: 'form', id: 'target', title: 'Target', fields: [{ key: 'host', label: 'Host', required: true }] },
                    { type: 'choice', id: 'env', title: 'Environment', options: [{ value: 'prod', label: 'Production' }] },
                    { type: 'terminal', id: 'run', title: 'Run', command: 'echo', args: ['deploy'] },
                    { type: 'browser', id: 'open', title: 'Open', url: 'https://example.com/' },
                ],
            },
        ],
    };
}

describe('validatePluginManifest — recipes', () => {
    it('accepts a well-formed recipe plugin', () => {
        const res = validatePluginManifest(validRecipePlugin());
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.manifest.recipes?.[0].id).toBe('deploy');
    });

    it('requires the `recipes` genieApi permission when recipes are present', () => {
        const m = validRecipePlugin();
        m.capabilities = { genieApi: [] };
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain("`capabilities.genieApi` must include \"recipes\"");
    });

    it('rejects a recipe with no steps', () => {
        const m = validRecipePlugin();
        (m.recipes as Array<Record<string, unknown>>)[0].steps = [];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('steps');
    });

    it('rejects an unknown step type', () => {
        const m = validRecipePlugin();
        (m.recipes as Array<{ steps: unknown[] }>)[0].steps = [{ type: 'task', id: 'x', title: 'X' }];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        // `task` needs a JS function → not expressible in a JSON manifest.
        if (!res.ok) expect(res.errors.join('\n')).toContain('type');
    });

    it('rejects a terminal step with no command', () => {
        const m = validRecipePlugin();
        (m.recipes as Array<{ steps: Array<Record<string, unknown>> }>)[0].steps = [
            { type: 'terminal', id: 'run', title: 'Run' },
        ];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('command');
    });

    it('rejects a browser step with no url', () => {
        const m = validRecipePlugin();
        (m.recipes as Array<{ steps: Array<Record<string, unknown>> }>)[0].steps = [
            { type: 'browser', id: 'open', title: 'Open' },
        ];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('url');
    });

    it('rejects duplicate step ids within a recipe', () => {
        const m = validRecipePlugin();
        (m.recipes as Array<{ steps: Array<Record<string, unknown>> }>)[0].steps = [
            { type: 'choice', id: 'dup', title: 'A', options: [{ value: 'a', label: 'A' }] },
            { type: 'choice', id: 'dup', title: 'B', options: [{ value: 'b', label: 'B' }] },
        ];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('duplicated');
    });

    it('rejects a choice step with no options', () => {
        const m = validRecipePlugin();
        (m.recipes as Array<{ steps: Array<Record<string, unknown>> }>)[0].steps = [
            { type: 'choice', id: 'env', title: 'Environment', options: [] },
        ];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('options');
    });

    it('rejects a form field missing key or label', () => {
        const m = validRecipePlugin();
        (m.recipes as Array<{ steps: Array<Record<string, unknown>> }>)[0].steps = [
            { type: 'form', id: 'f', title: 'F', fields: [{ label: 'No key' }] },
        ];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('key');
    });
});

/**
 * A minimal VALID panel-contributing plugin. A panel is a CLIENT surface that
 * mounts a DECLARED, vetted, Genie-bundled Fancy component (mirror of the editor
 * model) — the plugin ships no UI code. Contributing panels REQUIRES the grantable
 * `ui.panel` Genie-API permission the user consents to at enable-time.
 */
function validPanelPlugin(): Record<string, unknown> {
    return {
        id: 'ai.genie.repository',
        namespace: 'repository',
        name: 'Repository',
        version: '1.0.0',
        capabilities: { genieApi: [PANEL_CAPABILITY] },
        panels: [
            {
                id: 'changes',
                title: 'Repository',
                icon: 'git-branch',
                fancyComponent: {
                    package: '@particle-academy/fancy-git-ui',
                    version: '>=0.5.0',
                    export: 'RepoChangesPanel',
                },
            },
        ],
    };
}

describe('validatePluginManifest — panels', () => {
    it('accepts a well-formed panel plugin', () => {
        const res = validatePluginManifest(validPanelPlugin());
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.manifest.panels?.[0].id).toBe('changes');
            expect(res.manifest.panels?.[0].fancyComponent.export).toBe('RepoChangesPanel');
        }
    });

    it('exposes the `ui.panel` capability constant', () => {
        expect(PANEL_CAPABILITY).toBe('ui.panel');
    });

    it('requires the `ui.panel` genieApi permission when panels are present', () => {
        const m = validPanelPlugin();
        m.capabilities = { genieApi: [] };
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('`capabilities.genieApi` must include "ui.panel"');
    });

    it('requires a DECLARED first-party Fancy component (package + version + export)', () => {
        const m = validPanelPlugin();
        (m.panels as Array<Record<string, unknown>>)[0].fancyComponent = { package: 'x' };
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            const joined = res.errors.join('\n');
            expect(joined).toContain('fancyComponent.version');
            expect(joined).toContain('fancyComponent.export');
        }
    });

    it('requires a panel to have an id and a title', () => {
        const m = validPanelPlugin();
        (m.panels as Array<Record<string, unknown>>)[0].id = '';
        (m.panels as Array<Record<string, unknown>>)[0].title = '';
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            const joined = res.errors.join('\n');
            expect(joined).toContain('panels[0].id is required');
            expect(joined).toContain('panels[0].title is required');
        }
    });

    it('rejects duplicate panel ids', () => {
        const m = validPanelPlugin();
        m.panels = [
            (m.panels as unknown[])[0],
            (m.panels as unknown[])[0],
        ];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('duplicated');
    });

    it('rejects a non-array panels field', () => {
        const m = validPanelPlugin();
        m.panels = { id: 'x' };
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('`panels` must be an array');
    });
});

/**
 * The unified `contributes {}` block (design §3). A plugin declares every surface
 * kind in one block instead of growing unrelated top-level arrays; the legacy
 * top-level arrays remain accepted (older installed manifests) and normalize into
 * the same effective set. `contributes` and top-level surface arrays are mutually
 * exclusive — a manifest uses one form or the other, never both.
 */
// Fresh objects per call — tests mutate these, so shared module-level constants
// would leak corruption into later tests (they run in one process, in order).
const changesPanel = () => ({
    id: 'changes',
    title: 'Repository',
    fancyComponent: {
        package: '@particle-academy/fancy-git-ui',
        version: '>=0.5.0',
        export: 'RepoChangesPanel',
    },
});
const statusRecipe = () => ({
    id: 'status',
    title: 'Git status',
    steps: [{ type: 'terminal', id: 'run', title: 'Run', command: 'git', args: ['status'] }],
});

function validContributesPlugin(): Record<string, unknown> {
    return {
        id: 'ai.genie.repository',
        namespace: 'repository',
        name: 'Repository',
        version: '1.0.0',
        entry: { tools: 'tools.cjs' },
        agent: { guide: 'Use the repository tools when asked to inspect a repo.' },
        capabilities: { genieApi: [PANEL_CAPABILITY, RECIPE_CAPABILITY] },
        contributes: {
            panels: [changesPanel()],
            recipes: [statusRecipe()],
            mcpTools: [
                {
                    name: 'inspect',
                    description: 'Inspect the repo.',
                    inputSchema: { type: 'object', properties: {} },
                    run: 'tools',
                },
            ],
        },
    };
}

describe('validatePluginManifest — contributes {} block', () => {
    it('accepts a manifest that declares surfaces under `contributes`', () => {
        const res = validatePluginManifest(validContributesPlugin());
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.manifest.contributes?.panels?.[0].id).toBe('changes');
            expect(res.manifest.contributes?.recipes?.[0].id).toBe('status');
        }
    });

    it('lets one plugin declare BOTH a panel (primary) and recipes (secondary)', () => {
        const m = validContributesPlugin();
        // The repository shape: a Changes panel + git recipe wizards together.
        delete (m.contributes as Record<string, unknown>).mcpTools;
        delete m.entry;
        delete m.agent;
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(true);
        if (res.ok) {
            const c = manifestContributions(res.manifest);
            expect(c.panels).toHaveLength(1);
            expect(c.recipes).toHaveLength(1);
        }
    });

    it('validates contributes.recipes with the SAME rules (unknown step type rejected)', () => {
        const m = validContributesPlugin();
        (m.contributes as { recipes: Array<{ steps: unknown[] }> }).recipes[0].steps = [
            { type: 'task', id: 'x', title: 'X' },
        ];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('contributes.recipes[0].steps[0].type');
    });

    it('validates contributes.panels fancyComponent (mirrored per-array validation)', () => {
        const m = validContributesPlugin();
        (m.contributes as { panels: Array<Record<string, unknown>> }).panels[0].fancyComponent = { package: 'x' };
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            const joined = res.errors.join('\n');
            expect(joined).toContain('contributes.panels[0].fancyComponent.version');
            expect(joined).toContain('contributes.panels[0].fancyComponent.export');
        }
    });

    it('requires the ui.panel + recipes caps for contributes panels/recipes', () => {
        const m = validContributesPlugin();
        m.capabilities = { genieApi: [] };
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            const joined = res.errors.join('\n');
            expect(joined).toContain('"ui.panel"');
            expect(joined).toContain('"recipes"');
        }
    });

    it('requires agent.guide when contributes.mcpTools are present', () => {
        const m = validContributesPlugin();
        delete m.agent;
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('`agent.guide` is required when `mcpTools` are present');
    });

    it('rejects declaring the SAME surface both at top level AND in contributes', () => {
        const m = validContributesPlugin();
        m.panels = [changesPanel()]; // also top-level → ambiguous
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            const joined = res.errors.join('\n');
            expect(joined).toContain('contributes');
            expect(joined).toMatch(/not at the top level/i);
        }
    });

    it('rejects a non-object contributes', () => {
        const m = validContributesPlugin();
        m.contributes = [];
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('`contributes` must be an object');
    });

    it('accepts reserved surface kinds (flyouts/modals/pages) when present', () => {
        const m = validContributesPlugin();
        (m.contributes as Record<string, unknown>).flyouts = [
            { id: 'alerts', title: 'Alerts', fancyComponent: changesPanel().fancyComponent },
        ];
        (m.contributes as Record<string, unknown>).workstationPage = {
            fancyComponent: changesPanel().fancyComponent,
        };
        expect(validatePluginManifest(m).ok).toBe(true);
    });

    it('rejects a reserved kind of the wrong JSON type', () => {
        const m = validContributesPlugin();
        (m.contributes as Record<string, unknown>).flyouts = 'nope';
        const res = validatePluginManifest(m);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.errors.join('\n')).toContain('contributes.flyouts');
    });
});

describe('manifestContributions', () => {
    it('normalizes legacy top-level arrays into the effective set', () => {
        const legacy = validatePluginManifest({
            id: 'ai.genie.document',
            namespace: 'document',
            name: 'Document',
            version: '1.0.0',
            editors: [
                {
                    id: 'doc',
                    title: 'Document',
                    extensions: ['.md'],
                    fancyEditor: { package: 'p', version: '1.0.0', export: 'Editor' },
                },
            ],
        });
        expect(legacy.ok).toBe(true);
        if (legacy.ok) {
            const c = manifestContributions(legacy.manifest);
            expect(c.editors).toHaveLength(1);
            expect(c.panels).toHaveLength(0);
            expect(c.recipes).toHaveLength(0);
        }
    });

    it('reads from contributes when present', () => {
        const res = validatePluginManifest(validContributesPlugin());
        expect(res.ok).toBe(true);
        if (res.ok) {
            const c = manifestContributions(res.manifest);
            expect(c.panels).toHaveLength(1);
            expect(c.recipes).toHaveLength(1);
            expect(c.mcpTools).toHaveLength(1);
        }
    });

    it('returns empty arrays for a surface-less manifest', () => {
        const c = manifestContributions({
            id: 'x.y',
            namespace: 'x',
            name: 'X',
            version: '1.0.0',
        } as PluginManifest);
        expect(c.mcpTools).toEqual([]);
        expect(c.editors).toEqual([]);
        expect(c.recipes).toEqual([]);
        expect(c.panels).toEqual([]);
    });
});
