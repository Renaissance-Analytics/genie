import { describe, expect, it } from 'vitest';
import { checkedAgoLabel, pluginSummaryLine } from '../plugins-view';
import type { InstalledPluginView } from '../genie';

/**
 * The COLLAPSED plugin row's summary line, and the marketplace "checked" stamp.
 *
 * Both are pure so the decision about what survives collapsing — and whether a
 * cached index looks stale — is testable without a DOM.
 */

function view(over: Partial<InstalledPluginView> = {}): InstalledPluginView {
    return {
        id: 'com.example.plugin',
        name: 'Example',
        version: '1.2.3',
        namespace: 'example',
        description: null,
        enabled: false,
        sourceType: 'repo',
        sourceUrl: null,
        marketplaceId: null,
        publisher: null,
        tools: [],
        editors: [],
        panels: [],
        sides: { client: false, host: false },
        permissions: [],
        integrity: null,
        signed: false,
        trust: 'trusted',
        publisherKeyId: null,
        devApproved: false,
        ...over,
    };
}

describe('pluginSummaryLine — what a COLLAPSED plugin row still says', () => {
    it('leads with the version and namespace', () => {
        expect(pluginSummaryLine(view())).toContain('v1.2.3');
        expect(pluginSummaryLine(view())).toContain('example');
    });

    it('names the KIND: agent tools run here, editors render client-side', () => {
        const tools = view({
            sides: { client: false, host: true },
            tools: [{ name: 'example.doThing', description: 'x' }],
        });
        expect(pluginSummaryLine(tools)).toMatch(/1 tool\b/);

        const editors = view({
            sides: { client: true, host: false },
            editors: [{ id: 'e', title: 'E', extensions: ['.md'], fancyEditor: 'p@1#E' }],
        });
        expect(pluginSummaryLine(editors)).toMatch(/1 editor\b/);
    });

    it('pluralises and reports both kinds when a plugin contributes both', () => {
        const both = view({
            sides: { client: true, host: true },
            tools: [
                { name: 'a', description: '' },
                { name: 'b', description: '' },
            ],
            editors: [
                { id: 'e1', title: 'E1', extensions: ['.md'], fancyEditor: 'p@1#E' },
                { id: 'e2', title: 'E2', extensions: ['.txt'], fancyEditor: 'p@1#E' },
            ],
        });
        expect(pluginSummaryLine(both)).toMatch(/2 tools/);
        expect(pluginSummaryLine(both)).toMatch(/2 editors/);
    });

    it('names a contributed workspace panel', () => {
        const panels = view({
            sides: { client: true, host: false },
            panels: [{ id: 'changes', title: 'Repository', fancyComponent: 'p@1#RepoChangesPanel' }],
        });
        expect(pluginSummaryLine(panels)).toMatch(/1 panel\b/);
    });

    it('says a plugin contributes nothing rather than trailing an empty separator', () => {
        expect(pluginSummaryLine(view())).toBe('v1.2.3 · example');
    });

    it('flags ungranted permissions, because they are hidden once collapsed', () => {
        const p = view({
            sides: { client: false, host: true },
            enabled: true,
            tools: [{ name: 'a', description: '' }],
            permissions: [
                { category: 'fs', key: 'workspace', label: 'Files: workspace', granted: true },
                { category: 'network', key: 'api.example.com', label: 'Network: api.example.com', granted: false },
            ],
        });
        expect(pluginSummaryLine(p)).toMatch(/1 of 2 permissions/);
    });

    it('stays quiet about permissions when every declared one is granted', () => {
        const p = view({
            sides: { client: false, host: true },
            enabled: true,
            tools: [{ name: 'a', description: '' }],
            permissions: [{ category: 'fs', key: 'workspace', label: 'Files: workspace', granted: true }],
        });
        expect(pluginSummaryLine(p)).not.toMatch(/permission/);
    });
});

describe('checkedAgoLabel — is this cached marketplace index stale?', () => {
    const now = Date.parse('2026-08-02T12:00:00.000Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();

    it('reads as just-now inside a minute', () => {
        expect(checkedAgoLabel(ago(5_000), now)).toBe('Checked just now');
    });

    it('counts minutes, then hours, then days', () => {
        expect(checkedAgoLabel(ago(3 * 60_000), now)).toBe('Checked 3 minutes ago');
        expect(checkedAgoLabel(ago(60 * 60_000), now)).toBe('Checked 1 hour ago');
        expect(checkedAgoLabel(ago(50 * 60 * 60_000), now)).toBe('Checked 2 days ago');
    });

    it('says never when the index has not been fetched', () => {
        expect(checkedAgoLabel(null, now)).toBe('Never checked');
        expect(checkedAgoLabel('not-a-date', now)).toBe('Never checked');
    });
});
