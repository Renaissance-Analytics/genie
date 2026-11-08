import { describe, expect, it } from 'vitest';
import { Catalog, type ElementDefinition } from '../src/core/catalog.js';
import { adapterFor, CatalogReplica, type CatalogChange, type CatalogSnapshot } from '../src/core/catalog-sync.js';
import { ENGINE_METHODS, ENGINE_PROTOCOL } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import { CatalogService } from '../src/main/catalog-host.js';
import { genieCatalog, pluginPackage } from '../src/main/genie-catalog.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';

/**
 * ADF A4 (Tynn #448; spec .ai/plans/specs/adf-sdk.md, story A4): THE CATALOG CROSSES THE ENGINE CONNECTION. Engine protocol
 * 3: a revisioned `catalog.snapshot`, pushed `catalog.changed` (upserts and removals, each from a base revision), and
 * `catalog.docs` for one element. A window keeps a replica: a change whose base is not the revision it holds means it
 * missed one, so it asks for the snapshot again and ends equal to the host. And a window that lacks the compiled adapter
 * an element names says "needs a newer Genie" — never a blank pane.
 */

const lint = (version: string, tools: string[]) => ({
    id: 'acme.lint', name: 'Acme Lint', version, publisher: { name: 'Acme', keyId: 'k' },
    mcpTools: tools.map((name) => ({ name, description: `Run ${name}`, inputSchema: { type: 'object' }, run: 'tools/x.js', process: 'subprocess' as const, gated: false })),
    capabilities: { network: { hosts: [] }, genieApi: [] }, panels: [], editors: [],
});
/** A host whose catalog is Genie's own plus, when installed, the acme.lint plugin at some version. */
function host() {
    let installed: ReturnType<typeof lint> | null = null;
    const service = new CatalogService(() => {
        const c = genieCatalog();
        if (installed) { const r = c.register(pluginPackage(installed as never, 'plugin')); if (!r.ok) throw new Error(r.problems.join('; ')); }
        return c;
    });
    return { service, install: (m: ReturnType<typeof lint> | null) => { installed = m; service.rebuild(); } };
}
const ids = (defs: readonly ElementDefinition[]) => defs.map((d) => d.id).sort();

describe('a replica that misses a revision resnapshots and ends equal to the host', () => {
    it('applies changes in order; a change from a base it does not hold makes it ask for the snapshot again', async () => {
        const h = host();
        const pushed: CatalogChange[] = [];
        h.service.onEvent((change) => pushed.push(change));
        let resnapshots = 0;
        const replica = new CatalogReplica(async () => { resnapshots++; return h.service.snapshot(); });
        replica.rebase(h.service.snapshot());
        expect(replica.revision).toBe(h.service.snapshot().revision);

        h.install(lint('1.0.0', ['lint']));          // revision N
        await replica.apply(pushed[0]!);
        expect(replica.get('acme.lint.lint')).not.toBeNull();
        expect(resnapshots).toBe(0);

        h.install(lint('1.1.0', ['lint', 'fix']));   // revision N+1 — this window MISSES it
        h.install(lint('1.2.0', ['fix']));           // revision N+2 — its base is N+1, not what the replica holds
        await replica.apply(pushed[2]!);
        expect(resnapshots).toBe(1);
        const now: CatalogSnapshot = h.service.snapshot();
        expect(replica.revision).toBe(now.revision);
        expect(ids(replica.list())).toEqual(ids(now.definitions));
        expect(replica.get('acme.lint.lint')).toBeNull();
        expect(replica.get('acme.lint.fix')?.version).toBe('1.2.0');
    });

    it('a change carries what changed only: upserts by id, removals by id, from base to revision', () => {
        const h = host();
        const pushed: CatalogChange[] = [];
        h.service.onEvent((change) => pushed.push(change));
        const before = h.service.snapshot().revision;
        h.install(lint('1.0.0', ['lint', 'fix']));
        h.install(lint('1.0.1', ['lint']));
        expect(pushed[0]).toMatchObject({ base: before, revision: before + 1, remove: [] });
        expect(ids(pushed[0]!.upsert)).toEqual(['acme.lint.fix', 'acme.lint.lint']);
        expect(pushed[1]).toMatchObject({ base: before + 1, revision: before + 2, remove: ['acme.lint.fix'] });
        expect(ids(pushed[1]!.upsert)).toEqual(['acme.lint.lint']);
        // CONTROL: a rebuild that changes nothing moves no revision and says nothing.
        h.install(lint('1.0.1', ['lint']));
        expect(pushed).toHaveLength(2);
    });

    it('catalog.docs answers one element’s definition by kind and id; an unknown one is null', () => {
        const h = host();
        expect(h.service.docs('tool', 'ai.genie.spreadsheet.createWorkbook')).toMatchObject({ kind: 'tool', docs: { name: 'Spreadsheet: Create workbook' } });
        expect(h.service.docs('editor', 'ai.genie.spreadsheet.createWorkbook')).toBeNull();
        expect(h.service.docs('tool', 'nope')).toBeNull();
    });
});

describe('over the engine connection (protocol 3)', () => {
    it('ENGINE_PROTOCOL is 3, and catalog.snapshot and catalog.docs are on the allowlist', () => {
        expect(ENGINE_PROTOCOL).toBe(3);
        expect(ENGINE_METHODS as readonly string[]).toEqual(expect.arrayContaining(['catalog.snapshot', 'catalog.docs']));
    });

    it('a window connects with the snapshot; the host’s change reaches it; it asks docs; it ends equal to the host', async () => {
        const h = host();
        const server = new SessionEngineServer({ token: 'T'.repeat(32), build: 'test', catalog: h.service });
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, 'T'.repeat(32));
        const replica = client.catalog();
        expect(replica.revision).toBe(h.service.snapshot().revision);
        expect(ids(replica.list())).toEqual(ids(h.service.snapshot().definitions));
        h.install(lint('1.0.0', ['lint']));
        await new Promise((r) => setTimeout(r, 20));
        expect(replica.get('acme.lint.lint')?.version).toBe('1.0.0');
        expect(replica.revision).toBe(h.service.snapshot().revision);
        expect(await client.catalogDocs('tool', 'acme.lint.lint')).toMatchObject({ id: 'acme.lint.lint', kind: 'tool' });
    });
});

describe('a window without the adapter says so', () => {
    const catalog = genieCatalog();
    const sheet = catalog.get('ai.genie.spreadsheet.sheet')!;
    const board = catalog.get('ai.genie.artboard.board')!;

    it('an editor or panel whose compiled adapter this window has opens with it', () => {
        expect(adapterFor(sheet, { editors: ['SheetWorkbook'], panels: [] })).toEqual({ ok: true, adapter: 'SheetWorkbook' });
        expect(adapterFor(board, { editors: [], panels: ['ArtBoardPanel'] })).toEqual({ ok: true, adapter: 'ArtBoardPanel' });
    });

    it('one this OLDER window lacks: "needs a newer Genie", naming the element — never a blank pane', () => {
        const r = adapterFor(sheet, { editors: ['Editor'], panels: [] });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/needs a newer Genie/);
        if (!r.ok) expect(r.reason).toContain('Sheets');
        const p = adapterFor(board, { editors: [], panels: [] });
        expect(p.ok).toBe(false);
        if (!p.ok) expect(p.reason).toMatch(/needs a newer Genie/);
    });

    it('CONTROL: a kind with no window adapter (a tool) is not something to open', () => {
        const tool = catalog.get('ai.genie.spreadsheet.createWorkbook')!;
        expect(adapterFor(tool, { editors: ['SheetWorkbook'], panels: [] })).toMatchObject({ ok: false });
    });
});

void Catalog;
