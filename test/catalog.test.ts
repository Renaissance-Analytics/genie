import { describe, expect, it } from 'vitest';
import { Catalog, ELEMENT_KINDS, ELEMENT_SOURCES, RESERVED_KINDS, validateDefinition } from '../src/core/catalog.js';

/**
 * ADF A1 (Tynn #445; spec .ai/plans/specs/adf-sdk.md, story A1): ONE definition envelope and ONE validator for every
 * element a builtin, a plugin or a GApp contributes, and a catalog that registers a package ATOMICALLY with a revision.
 * A package with one bad contribution registers none of them; a good one registers all of them at revision + 1.
 *
 * The owner's approved decisions this encodes (q_f0804e19): kinds now for what a plugin or GApp can contribute (1);
 * Genie 1's never-run families are accepted as RESERVED (3); an unsigned package gets no network egress unless granted,
 * so `permissions.network` is an allow-list that defaults to none (4).
 */

const PKG = 'ai.genie.spreadsheet';
const tool = (over: Record<string, unknown> = {}) => ({
    id: 'ai.genie.spreadsheet.createWorkbook',
    kind: 'tool',
    version: '1.0.0',
    packageId: PKG,
    source: 'builtin',
    docs: { name: 'Create workbook', description: 'Generate an .xlsx workbook from structured data.' },
    reach: { scopes: ['workspace'], side: 'host', requiresWindow: false, remote: 'allowed' },
    permissions: { capabilities: ['files'], network: [] },
    payload: { handler: 'spreadsheet.createWorkbook', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    ...over,
});
const editor = (over: Record<string, unknown> = {}) => ({
    ...tool(),
    id: 'ai.genie.spreadsheet.editor',
    kind: 'editor',
    // An editor runs on BOTH sides (the owner's ruling q_d71981d6): drawn by a client, its file read and written on the host.
    reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'allowed', link: { calls: ['files.readBytes', 'files.writeBytes'], events: [] } },
    payload: { extensions: ['.xlsx', '.csv'], fancyEditor: 'SheetWorkbook' },
    ...over,
});
const panel = (over: Record<string, unknown> = {}) => ({
    ...tool(),
    id: 'ai.genie.spreadsheet.panel',
    kind: 'panel',
    reach: { scopes: ['workspace'], side: 'client', requiresWindow: true, remote: 'allowed' },
    payload: { fancyComponent: 'JsonEditor', props: {} },
    ...over,
});
const pkg = (contributions: unknown[], over: Record<string, unknown> = {}) => ({ id: PKG, version: '1.0.0', source: 'builtin', contributions, ...over });

describe('atomic package registration with revisions (the acceptance test)', () => {
    it('a package with ONE bad contribution registers NONE of them, and the revision does not move', () => {
        const catalog = new Catalog();
        const bad = editor({ payload: { extensions: ['.xlsx'], fancyEditor: 'NotVetted' } });
        const r = catalog.register(pkg([tool(), panel(), bad]));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.problems.join('\n')).toMatch(/ai\.genie\.spreadsheet\.editor.*NotVetted/);
        expect(catalog.list()).toEqual([]);
        expect(catalog.get('ai.genie.spreadsheet.createWorkbook')).toBeNull();
        expect(catalog.revision).toBe(0);
    });

    it('the same package made good registers ALL its contributions at revision + 1 (CONTROL for the one above)', () => {
        const catalog = new Catalog();
        expect(catalog.register(pkg([tool(), panel(), editor({ payload: { extensions: ['.xlsx'], fancyEditor: 'NotVetted' } })])).ok).toBe(false);
        const before = catalog.revision;
        const r = catalog.register(pkg([tool(), panel(), editor()]));
        expect(r).toEqual({ ok: true, revision: before + 1 });
        expect(catalog.list().map((d) => d.id).sort()).toEqual(['ai.genie.spreadsheet.createWorkbook', 'ai.genie.spreadsheet.editor', 'ai.genie.spreadsheet.panel']);
        expect(catalog.list('editor').map((d) => d.id)).toEqual(['ai.genie.spreadsheet.editor']);
        expect(catalog.get('ai.genie.spreadsheet.createWorkbook')).toMatchObject({ kind: 'tool', packageId: PKG, source: 'builtin', version: '1.0.0' });
    });

    it('an update replaces the package whole: a dropped contribution is gone, at the next revision', () => {
        const catalog = new Catalog();
        catalog.register(pkg([tool(), panel(), editor()]));
        const r = catalog.register(pkg([tool({ version: '1.1.0' })], { version: '1.1.0' }));
        expect(r).toEqual({ ok: true, revision: 2 });
        expect(catalog.list().map((d) => d.id)).toEqual(['ai.genie.spreadsheet.createWorkbook']);
        expect(catalog.get('ai.genie.spreadsheet.createWorkbook')?.version).toBe('1.1.0');
    });

    it('a BAD update leaves the previous version whole (none of it removed, none of the new added)', () => {
        const catalog = new Catalog();
        catalog.register(pkg([tool(), panel(), editor()]));
        const r = catalog.register(pkg([tool({ version: '2.0.0' }), panel({ payload: { fancyComponent: 'Iframe' } })], { version: '2.0.0' }));
        expect(r.ok).toBe(false);
        expect(catalog.revision).toBe(1);
        expect(catalog.list()).toHaveLength(3);
        expect(catalog.get('ai.genie.spreadsheet.createWorkbook')?.version).toBe('1.0.0');
    });

    it('another package claiming an id that is taken is refused whole; the owner keeps it', () => {
        const catalog = new Catalog();
        catalog.register(pkg([tool()]));
        const other = 'com.example.sheets';
        const theirs = (over: Record<string, unknown>) => tool({ packageId: other, source: 'plugin', ...over });
        const takesId = catalog.register({ id: other, version: '1.0.0', source: 'plugin', contributions: [theirs({ id: 'com.example.sheets.fine' }), theirs({})] });
        expect(takesId.ok).toBe(false);
        if (!takesId.ok) expect(takesId.problems.join('\n')).toMatch(/ai\.genie\.spreadsheet\.createWorkbook.*ai\.genie\.spreadsheet/);
        expect(catalog.get('com.example.sheets.fine')).toBeNull();
        expect(catalog.revision).toBe(1);
        expect(catalog.get('ai.genie.spreadsheet.createWorkbook')?.packageId).toBe(PKG);
    });

    it('a contribution must belong to its package: its packageId and source are the package’s, its id appears once', () => {
        const catalog = new Catalog();
        expect(catalog.register(pkg([tool({ packageId: 'com.example.other' })])).ok).toBe(false);
        expect(catalog.register(pkg([tool({ source: 'plugin' })])).ok).toBe(false);
        expect(catalog.register(pkg([tool(), tool()])).ok).toBe(false);
        expect(catalog.register(pkg([tool()], { source: 'market' })).ok).toBe(false);
        expect(catalog.register(pkg([tool()], { id: 'Not A Package' })).ok).toBe(false);
        expect(catalog.revision).toBe(0);
        expect(catalog.list()).toEqual([]);
    });

    it('unregister removes the whole package at the next revision; an unknown package moves nothing', () => {
        const catalog = new Catalog();
        catalog.register(pkg([tool(), panel()]));
        expect(catalog.unregister('com.example.unknown')).toMatchObject({ ok: false });
        expect(catalog.unregister(PKG)).toEqual({ ok: true, revision: 2 });
        expect(catalog.list()).toEqual([]);
        expect(catalog.get('ai.genie.spreadsheet.panel')).toBeNull();
    });

    it('what is registered cannot be changed from outside: neither the input after the call nor a listed definition', () => {
        const catalog = new Catalog();
        const input = tool();
        catalog.register(pkg([input]));
        (input.docs as { name: string }).name = 'changed';
        expect(catalog.get(input.id)?.docs.name).toBe('Create workbook');
        expect(Object.isFrozen(catalog.get(input.id))).toBe(true);
        expect(Object.isFrozen(catalog.get(input.id)?.payload)).toBe(true);
    });
});

describe('one envelope, one validator', () => {
    it('a complete definition passes, with defaults filled (no network)', () => {
        const r = validateDefinition(tool({ permissions: { capabilities: [] } }));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.definition).toMatchObject({ permissions: { capabilities: [], network: [] } });
    });

    it.each([
        ['id', 'id'], ['kind', 'kind'], ['version', 'version'], ['packageId', 'packageId'], ['source', 'source'],
        ['docs', 'docs'], ['reach', 'reach'], ['permissions', 'permissions'], ['payload', 'payload'],
    ])('without %s it is refused, and the problem names it', (field, named) => {
        const raw: Record<string, unknown> = tool();
        delete raw[field];
        const r = validateDefinition(raw);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.problems.join('\n')).toContain(named);
    });

    it('is strict: an unknown key is refused by name', () => {
        const r = validateDefinition(tool({ run: 'evil.js' }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.problems.join('\n')).toContain('"run"');
    });

    it('the fields themselves: a semver version, a known source, docs with a name and description, a reach that says where', () => {
        for (const bad of [
            { version: 'latest' },
            { source: 'market' },
            { docs: { name: '', description: 'x' } },
            { docs: { name: 'x' } },
            { reach: { scopes: [], side: 'host', requiresWindow: false, remote: 'allowed' } },
            { reach: { scopes: ['galaxy'], side: 'host', requiresWindow: false, remote: 'allowed' } },
            { reach: { scopes: ['workspace'], side: 'cloud', requiresWindow: false, remote: 'allowed' } },
            { reach: { scopes: ['workspace'], side: 'host', requiresWindow: 'no', remote: 'allowed' } },
            { reach: { scopes: ['workspace'], side: 'host', requiresWindow: false, remote: 'anyone' } },
            { permissions: { capabilities: [3], network: [] } },
            { permissions: { capabilities: [], network: 'everywhere' } },
            { id: 'has space' },
        ]) expect(validateDefinition(tool(bad)).ok, JSON.stringify(bad)).toBe(false);
    });

    it('the kinds: what a plugin or GApp can contribute, plus Genie 1’s reserved families (decision 1 and 3)', () => {
        expect([...ELEMENT_KINDS].sort()).toEqual(['editor', 'flow-node', 'overlay', 'page', 'panel', 'provider', 'recipe', 'service-engine', 'tool']);
        expect([...RESERVED_KINDS].sort()).toEqual(['flyout', 'modal', 'wizard', 'workspace-settings-page', 'workstation-page']);
        expect([...ELEMENT_SOURCES]).toEqual(['builtin', 'plugin', 'gapp']);
        expect(validateDefinition(tool({ kind: 'flyout', payload: {} })).ok).toBe(true);
        expect(validateDefinition(tool({ kind: 'settings-port', payload: {} })).ok).toBe(false);
    });

    it('each kind’s payload is checked by the same validator', () => {
        // tool: a handler and an object input schema
        expect(validateDefinition(tool({ payload: { handler: 'x' } })).ok).toBe(false);
        expect(validateDefinition(tool({ payload: { handler: 'x', inputSchema: { type: 'string' } } })).ok).toBe(false);
        expect(validateDefinition(tool({ payload: { inputSchema: { type: 'object' } } })).ok).toBe(false);
        // editor: extensions it claims, a vetted Fancy editor
        expect(validateDefinition(editor({ payload: { extensions: [], fancyEditor: 'SheetWorkbook' } })).ok).toBe(false);
        expect(validateDefinition(editor({ payload: { extensions: ['xlsx'], fancyEditor: 'SheetWorkbook' } })).ok).toBe(false);
        expect(validateDefinition(editor()).ok).toBe(true);
        // panel: a vetted Fancy component; props an object
        expect(validateDefinition(panel({ payload: { fancyComponent: 'Iframe' } })).ok).toBe(false);
        expect(validateDefinition(panel({ payload: { fancyComponent: 'JsonEditor', props: 'x' } })).ok).toBe(false);
        expect(validateDefinition(panel()).ok).toBe(true);
        // flow-node: an executor; recipe: steps
        expect(validateDefinition(tool({ kind: 'flow-node', payload: {} })).ok).toBe(false);
        expect(validateDefinition(tool({ kind: 'flow-node', payload: { executor: 'sheets.append', inputs: ['rows'], outputs: ['path'] } })).ok).toBe(true);
        expect(validateDefinition(tool({ kind: 'recipe', payload: { steps: [] } })).ok).toBe(false);
        expect(validateDefinition(tool({ kind: 'recipe', payload: { steps: [{ tool: 'ai.genie.spreadsheet.createWorkbook' }] } })).ok).toBe(true);
        // every kind: the payload is an object
        expect(validateDefinition(tool({ kind: 'page', payload: 'x' })).ok).toBe(false);
    });

    it('serializable only: a function anywhere in the definition is refused (metadata crosses the wire, never code)', () => {
        expect(validateDefinition(tool({ payload: { handler: 'x', inputSchema: { type: 'object' }, run: () => 1 } })).ok).toBe(false);
    });
});
