import { describe, expect, it } from 'vitest';
import {
    panelKindForSpecType,
    specTypeForOpen,
    pluginSpecMeta,
    pickReusePluginPanel,
    type PluginEditorRef,
} from '../panel-routing';
import type { TerminalSpec } from '../genie';

/**
 * Phase-2 routing decisions (§2.2/§6.1): PanelFor dispatch by spec type, and the
 * open-file receiver choosing a plugin editor spec vs the default code editor.
 */

const ref: PluginEditorRef = {
    pluginId: 'ai.genie.presentation',
    editorId: 'deck',
    fancyExport: 'DeckEditor',
    fancyPackage: '@particle-academy/fancy-slides',
    fancyVersion: '>=0.1.0',
};

function spec(over: Partial<TerminalSpec>): TerminalSpec {
    return {
        id: 'x',
        workspace_id: 'ws1',
        label: 'l',
        cwd: '/ws1',
        shell: null,
        args: [],
        env: {},
        type: 'plugin',
        meta: {},
        sort_order: 0,
        created_at: '',
        last_opened_at: null,
        snapshot_at: null,
        snapshot_bytes: null,
        live_cwd: null,
        enabled: true,
        ...over,
    };
}

describe('panelKindForSpecType', () => {
    it('routes plugin specs to the plugin host, code to code, else terminal', () => {
        expect(panelKindForSpecType('plugin')).toBe('plugin');
        expect(panelKindForSpecType('code')).toBe('code');
        expect(panelKindForSpecType('terminal')).toBe('terminal');
        expect(panelKindForSpecType('process')).toBe('terminal');
    });
});

describe('specTypeForOpen', () => {
    it('is plugin when a plugin editor was resolved, else code (unchanged)', () => {
        expect(specTypeForOpen(ref)).toBe('plugin');
        expect(specTypeForOpen(null)).toBe('code');
        expect(specTypeForOpen(undefined)).toBe('code');
    });
});

describe('pluginSpecMeta', () => {
    it('carries plugin id + editor id + file + fancy mapping', () => {
        const meta = pluginSpecMeta(ref, 'decks/q3.pptx', false);
        expect(meta.plugin_id).toBe('ai.genie.presentation');
        expect(meta.editor_id).toBe('deck');
        expect(meta.file).toBe('decks/q3.pptx');
        expect(meta.fancy_export).toBe('DeckEditor');
        expect(meta.system).toBeUndefined();
    });
    it('tags a System-workspace spec', () => {
        expect(pluginSpecMeta(ref, 'q3.pptx', true).system).toBe(true);
    });
});

describe('pickReusePluginPanel', () => {
    const s1 = spec({ id: 'p1', type: 'plugin', meta: { plugin_id: 'ai.genie.presentation', file: 'a.pptx' } });
    const s2 = spec({ id: 'p2', type: 'plugin', meta: { plugin_id: 'ai.genie.presentation', file: 'b.pptx' } });

    it('reuses a selected plugin panel already open on the same file', () => {
        expect(pickReusePluginPanel([s1, s2], { pluginId: 'ai.genie.presentation', file: 'b.pptx' }, new Set(['p1', 'p2']))).toBe('p2');
    });
    it('does not reuse an unselected (unmounted) panel', () => {
        expect(pickReusePluginPanel([s1], { pluginId: 'ai.genie.presentation', file: 'a.pptx' }, new Set())).toBeNull();
    });
    it('does not reuse a different file', () => {
        expect(pickReusePluginPanel([s1], { pluginId: 'ai.genie.presentation', file: 'zzz.pptx' }, new Set(['p1']))).toBeNull();
    });
});
