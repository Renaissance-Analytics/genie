import { describe, expect, it } from 'vitest';
import {
    pluginSides,
    requiresHostEnablement,
    editorClaiming,
    clientEditorExtensions,
    pluginFileExtension,
} from '../side';
import { BUNDLED_PLUGIN_SOURCES } from '../official';
import type { PluginManifest } from '../manifest';

/**
 * The explicit CLIENT / HOST classification (genie plugin client-host split).
 *
 * A plugin's SURFACES decide where it runs, not the plugin as a whole:
 *   - `editors[]`             → a CLIENT surface (a Fancy component rendered in
 *                               the client window; the plugin ships no code).
 *   - `mcpTools[]`/`recipes[]`→ a HOST surface (code that RUNS on the host).
 * Only host surfaces need host enablement + consent grants; a client editor must
 * never be gated on a host toggle.
 */

function manifest(over: Record<string, unknown> = {}): PluginManifest {
    return {
        id: 'test.side.plugin',
        namespace: 'sideplugin',
        name: 'Side Plugin',
        version: '1.0.0',
        ...over,
    } as unknown as PluginManifest;
}

const EDITOR = {
    id: 'doc',
    title: 'Document',
    extensions: ['.md', '.markdown'],
    fancyEditor: { package: '@particle-academy/react-fancy', version: '>=4.9.0', export: 'Editor' },
};

const TOOL = {
    name: 'doThing',
    description: 'Do a thing.',
    inputSchema: { type: 'object' as const },
};

describe('pluginSides', () => {
    it('classifies an editors-only plugin as CLIENT-side only', () => {
        expect(pluginSides(manifest({ editors: [EDITOR] }))).toEqual({ client: true, host: false });
    });

    it('classifies an mcpTools plugin as HOST-side only', () => {
        expect(pluginSides(manifest({ mcpTools: [TOOL] }))).toEqual({ client: false, host: true });
    });

    it('classifies a recipes plugin as HOST-side (its steps run on the host)', () => {
        const recipes = [{ id: 'r', title: 'R', steps: [{ type: 'form', id: 'f', title: 'F', fields: [] }] }];
        expect(pluginSides(manifest({ recipes })).host).toBe(true);
    });

    it('classifies a plugin with BOTH surfaces as client AND host', () => {
        expect(pluginSides(manifest({ editors: [EDITOR], mcpTools: [TOOL] }))).toEqual({
            client: true,
            host: true,
        });
    });

    it('classifies a plugin with no surfaces as neither', () => {
        expect(pluginSides(manifest())).toEqual({ client: false, host: false });
    });
});

describe('requiresHostEnablement', () => {
    it('is FALSE for an editors-only (client-side) plugin', () => {
        expect(requiresHostEnablement(manifest({ editors: [EDITOR] }))).toBe(false);
    });

    it('is TRUE for anything that runs code on the host', () => {
        expect(requiresHostEnablement(manifest({ mcpTools: [TOOL] }))).toBe(true);
        expect(requiresHostEnablement(manifest({ editors: [EDITOR], mcpTools: [TOOL] }))).toBe(true);
    });
});

describe('the bundled first-party plugins', () => {
    it('classifies Document as CLIENT-side only — no host enablement needed', () => {
        const doc = BUNDLED_PLUGIN_SOURCES.find((b) => b.id === 'ai.genie.document')!;
        const m = doc.manifest as unknown as PluginManifest;
        expect(pluginSides(m)).toEqual({ client: true, host: false });
        expect(requiresHostEnablement(m)).toBe(false);
    });

    it('classifies Presentation as BOTH (a deck editor plus a host generator tool)', () => {
        const deck = BUNDLED_PLUGIN_SOURCES.find((b) => b.id === 'ai.genie.presentation')!;
        expect(pluginSides(deck.manifest as unknown as PluginManifest)).toEqual({
            client: true,
            host: true,
        });
    });
});

describe('pluginFileExtension', () => {
    it('lowercases the extension of the final path segment', () => {
        expect(pluginFileExtension('docs/Notes.MD')).toBe('.md');
        expect(pluginFileExtension('a.md/../b.txt')).toBe('.txt');
        expect(pluginFileExtension('Makefile')).toBe('');
        expect(pluginFileExtension('.env')).toBe('');
    });
});

describe('editorClaiming / clientEditorExtensions', () => {
    const m = manifest({
        editors: [EDITOR],
        capabilities: { fs: { scope: 'workspace', extensions: ['.md', '.markdown', '.pdf'] } },
    });

    it('finds the editor that claims a file type', () => {
        expect(editorClaiming(m, 'notes.md')?.id).toBe('doc');
        expect(editorClaiming(m, 'report.pdf')).toBeNull();
    });

    it('narrows the fs allow-list to the claiming editor INTERSECT the declared fs scope', () => {
        // `.pdf` is declared for fs but claimed by no editor → never in the list.
        expect(clientEditorExtensions(m, 'notes.md').sort()).toEqual(['.markdown', '.md']);
    });

    it('is EMPTY (fail-closed) when no editor claims the file type', () => {
        expect(clientEditorExtensions(m, 'report.pdf')).toEqual([]);
    });

    it('is EMPTY (fail-closed) when the plugin declares no workspace fs scope', () => {
        expect(clientEditorExtensions(manifest({ editors: [EDITOR] }), 'notes.md')).toEqual([]);
    });
});
