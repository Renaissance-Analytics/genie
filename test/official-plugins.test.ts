import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OFFICIAL_PLUGINS } from '../src/core/official-plugins.js';
import { editorFor } from '../src/core/plugin-editors.js';
import { parseManifest } from '../src/core/plugins.js';
import { PluginHost } from '../src/main/plugin-host.js';

/**
 * GENIE 1'S OFFICIAL PLUGINS, IN GENIE 2 (beta.33 item 14). The owner: "I STILL DO NOT SEE OUR PLUGINS SUPPORTED." Genie 1
 * shipped them in the box (main/plugins/official.ts BUNDLED_PLUGIN_SOURCES), trusted by construction because they come from
 * Genie's own signed bundle — never a folder someone dropped in, never a signature check against a publisher key. Genie 2
 * had none: a `.md` opened as raw text, a `.xlsx` as bytes.
 */

const byId = (id: string) => {
    const p = OFFICIAL_PLUGINS.find((o) => parseManifest(o.manifest).ok && (o.manifest as { id: string }).id === id);
    if (!p) throw new Error(`no official plugin ${id}`);
    const r = parseManifest(p.manifest);
    if (!r.ok) throw new Error(r.reason);
    return r.manifest;
};

describe('the official manifests', () => {
    it('every one is a manifest Genie\'s own strict parser accepts', () => {
        for (const p of OFFICIAL_PLUGINS) expect(parseManifest(p.manifest), JSON.stringify(p.manifest).slice(0, 80)).toMatchObject({ ok: true });
    });

    it('Document claims .md .markdown .mdc .docx with the WYSIWYG Editor, and may read and write exactly those', () => {
        const m = byId('ai.genie.document');
        expect(m.editors).toEqual([{ id: 'document', title: 'Document', extensions: ['.md', '.markdown', '.mdc', '.docx'], fancyEditor: { export: 'Editor' } }]);
        expect(m.capabilities.fs).toEqual({ scope: 'workspace', extensions: ['.md', '.markdown', '.mdc', '.docx'] });
    });

    it('Spreadsheet claims .xlsx .csv .ods with SheetWorkbook; Presentation claims .pptx with DeckEditor', () => {
        expect(byId('ai.genie.spreadsheet').editors?.[0]).toMatchObject({ extensions: ['.xlsx', '.csv', '.ods'], fancyEditor: { export: 'SheetWorkbook' } });
        expect(byId('ai.genie.presentation').editors?.[0]).toMatchObject({ extensions: ['.pptx'], fancyEditor: { export: 'DeckEditor' } });
    });
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-official-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the plugin host carries them', () => {
    it('listed first, enabled, labelled as shipping with Genie — with NO publisher key and developer mode OFF', async () => {
        const host = await PluginHost.open({ dir: join(dir, 'plugins'), keys: {}, developerMode: false, official: OFFICIAL_PLUGINS });
        const ids = host.list().map((p) => p.id);
        expect(ids.slice(0, 3)).toEqual(['ai.genie.document', 'ai.genie.spreadsheet', 'ai.genie.presentation']);
        for (const p of host.list()) expect(p).toMatchObject({ state: 'enabled', label: 'official — ships with Genie', reason: null });
    });

    it('their editors route files; disabling Document hands .md back to the code editor, and that survives a reopen', async () => {
        const host = await PluginHost.open({ dir: join(dir, 'plugins'), keys: {}, developerMode: false, official: OFFICIAL_PLUGINS });
        expect(editorFor(host.editors(), 'README.md')).toMatchObject({ pluginId: 'ai.genie.document', pluginName: 'Document' });
        expect(editorFor(host.editors(), 'q3.xlsx')).toMatchObject({ pluginId: 'ai.genie.spreadsheet' });
        expect(await host.setEnabled('ai.genie.document', false)).toBe(true);
        expect(editorFor(host.editors(), 'README.md')).toBeNull();
        const again = await PluginHost.open({ dir: join(dir, 'plugins'), keys: {}, developerMode: false, official: OFFICIAL_PLUGINS });
        expect(again.list().find((p) => p.id === 'ai.genie.document')).toMatchObject({ state: 'disabled' });
        expect(editorFor(again.editors(), 'README.md')).toBeNull();
        expect(editorFor(again.editors(), 'deck.pptx')).toMatchObject({ pluginId: 'ai.genie.presentation' });
    });

    it('the bytes gate: an enabled plugin\'s own claimed types only; a disabled or unknown plugin reads nothing', async () => {
        const host = await PluginHost.open({ dir: join(dir, 'plugins'), keys: {}, developerMode: false, official: OFFICIAL_PLUGINS });
        expect(host.editorBytes('ai.genie.document', 'a/README.md')).toEqual({ allowed: true });
        expect(host.editorBytes('ai.genie.document', 'a/book.xlsx')).toMatchObject({ allowed: false });
        expect(host.editorBytes('com.nobody.x', 'a.md')).toEqual({ allowed: false, reason: 'com.nobody.x is not an enabled plugin' });
        await host.setEnabled('ai.genie.document', false);
        expect(host.editorBytes('ai.genie.document', 'a.md')).toEqual({ allowed: false, reason: 'ai.genie.document is not an enabled plugin' });
    });

    it('a folder that claims an official id is not admitted in its place: listed invalid, with the reason', async () => {
        await mkdir(join(dir, 'plugins', 'imposter'), { recursive: true });
        await writeFile(join(dir, 'plugins', 'imposter', 'genie-plugin.json'), JSON.stringify({ id: 'ai.genie.document', name: 'Document', version: '9.0.0', publisher: { name: 'x', keyId: 'x' } }));
        const host = await PluginHost.open({ dir: join(dir, 'plugins'), keys: {}, developerMode: true, official: OFFICIAL_PLUGINS });
        expect(host.list().filter((p) => p.id === 'ai.genie.document')).toHaveLength(1);
        expect(host.list().find((p) => p.folder === 'imposter')).toMatchObject({ state: 'invalid', reason: 'ai.genie.document is an official plugin that ships with Genie; a folder cannot replace it' });
    });
});
