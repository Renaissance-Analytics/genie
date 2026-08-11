import { describe, expect, it } from 'vitest';
import { BUNDLED_PLUGIN_SOURCES } from '../official';
import {
    manifestContributions,
    validatePluginManifest,
    type PluginManifest,
} from '../manifest';

/**
 * Every BUNDLED first-party plugin declares its surfaces in the unified
 * `contributes {}` block (design §3), not the legacy top-level arrays. The legacy
 * top-level form stays SUPPORTED for third-party manifests — this only pins that
 * Genie's own bundled plugins model the new pattern.
 *
 * The second half is a CHARACTERIZATION guard: the EFFECTIVE contributions
 * (`manifestContributions`) of each bundled plugin are the exact tools / editors /
 * recipes / panels they shipped before the migration. These assertions held on
 * the legacy top-level shape and must still hold on `contributes {}` — that is the
 * proof the re-index changed nothing an agent, editor router, or Settings panel
 * can observe.
 */

const manifestOf = (id: string): PluginManifest =>
    BUNDLED_PLUGIN_SOURCES.find((b) => b.id === id)!.manifest as unknown as PluginManifest;

const ALL_BUNDLED = [
    'ai.genie.presentation',
    'ai.genie.spreadsheet',
    'ai.genie.document',
    'ai.genie.repository',
];

describe('bundled plugins declare surfaces via contributes {}', () => {
    it.each(ALL_BUNDLED)('%s uses `contributes` and no legacy top-level surface arrays', (id) => {
        const m = manifestOf(id);
        expect(m.contributes).toBeTruthy();
        expect(m.mcpTools).toBeUndefined();
        expect(m.editors).toBeUndefined();
        expect(m.recipes).toBeUndefined();
        expect(m.panels).toBeUndefined();
    });

    it.each(ALL_BUNDLED)('%s still validates against the strict schema', (id) => {
        expect(validatePluginManifest(manifestOf(id)).ok).toBe(true);
    });
});

describe('the effective contributions are unchanged by the migration', () => {
    it('Presentation: createDeck tool + the .pptx/.odp deck editor', () => {
        const c = manifestContributions(manifestOf('ai.genie.presentation'));
        expect(c.mcpTools.map((t) => t.name)).toEqual(['createDeck']);
        expect(c.editors.map((e) => e.id)).toEqual(['deck']);
        expect(c.editors[0].extensions).toEqual(['.pptx', '.odp']);
        expect(c.editors[0].fancyEditor.export).toBe('DeckEditor');
        expect(c.recipes).toHaveLength(0);
        expect(c.panels).toHaveLength(0);
    });

    it('Spreadsheet: createWorkbook tool + the .xlsx/.csv/.ods sheet editor', () => {
        const c = manifestContributions(manifestOf('ai.genie.spreadsheet'));
        expect(c.mcpTools.map((t) => t.name)).toEqual(['createWorkbook']);
        expect(c.editors.map((e) => e.id)).toEqual(['sheet']);
        expect(c.editors[0].extensions).toEqual(['.xlsx', '.csv', '.ods']);
        expect(c.editors[0].fancyEditor.export).toBe('SheetWorkbook');
        expect(c.recipes).toHaveLength(0);
        expect(c.panels).toHaveLength(0);
    });

    it('Document: no tools, the .md/.markdown/.mdc/.docx Editor', () => {
        const c = manifestContributions(manifestOf('ai.genie.document'));
        expect(c.mcpTools).toHaveLength(0);
        expect(c.editors.map((e) => e.id)).toEqual(['document']);
        expect(c.editors[0].extensions).toEqual(['.md', '.markdown', '.mdc', '.docx']);
        expect(c.editors[0].fancyEditor.export).toBe('Editor');
    });

    it('Repository: the Changes panel (primary) + the git recipe wizards (secondary)', () => {
        const c = manifestContributions(manifestOf('ai.genie.repository'));
        expect(c.panels.map((p) => p.id)).toEqual(['changes']);
        expect(c.recipes.map((r) => r.id)).toEqual([
            'status',
            'stage',
            'commit',
            'branch',
            'push',
            'pull',
            'pr',
        ]);
        expect(c.mcpTools).toHaveLength(0);
        expect(c.editors).toHaveLength(0);
    });
});
