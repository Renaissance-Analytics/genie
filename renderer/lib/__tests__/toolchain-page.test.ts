import { describe, expect, it } from 'vitest';
import {
    AGENT_CLI_TOOLS,
    DEV_TOOL_TOOLS,
    agentCliRows,
    defaultChangeNotice,
    devToolRows,
    formatBytes,
    installRowView,
    languageSections,
    removeConfirmation,
    sitesFollowingDefault,
    type ToolchainSiteUse,
} from '../toolchain-page';
import type { EngineInstall, ToolUpdate } from '../genie';

/**
 * The Toolchain page's VIEW model. The renderer test env has no DOM, so every
 * judgement the page makes lives here and is asserted directly: which tab a tool
 * belongs on, whether a row can be made the default or removed, and — the one
 * that carries a promise to the user — exactly WHICH sites a default change is
 * about to move.
 */

const gen = (version: string, over: Partial<EngineInstall> = {}): EngineInstall => ({
    tool: 'php',
    version,
    dir: `C:\\g\\toolchain\\php\\${version}`,
    exe: `C:\\g\\toolchain\\php\\${version}\\php.exe`,
    source: 'genie',
    removable: true,
    sizeBytes: 94_371_840,
    ...over,
});

const herd: EngineInstall = {
    tool: 'php',
    version: '8.4.1',
    dir: 'C:\\Users\\x\\.config\\herd\\bin\\php84',
    exe: 'C:\\Users\\x\\.config\\herd\\bin\\php84\\php.exe',
    source: 'herd',
    removable: false,
};

const update = (name: ToolUpdate['name'], over: Partial<ToolUpdate> = {}): ToolUpdate => ({
    name,
    installed: '1.0.0',
    updateAvailable: false,
    source: 'package-manager',
    ...over,
});

describe('the three tabs split the toolchain by how it is MANAGED', () => {
    it('keeps languages out of Dev tools — they are multi-version, and live on their own tab', () => {
        for (const lang of ['php', 'node', 'npm']) {
            expect(DEV_TOOL_TOOLS).not.toContain(lang);
        }
        expect([...DEV_TOOL_TOOLS]).toEqual(['git', 'docker', 'composer']);
    });

    it('separates the agent CLIs, because updating them is the one thing refused mid-turn', () => {
        expect([...AGENT_CLI_TOOLS]).toEqual(['claude-code', 'codex']);
    });

    it('routes each tool to exactly one tab, and drops the ones neither owns', () => {
        const updates = [
            update('git'),
            update('docker'),
            update('composer'),
            update('claude-code'),
            update('codex'),
            update('node'),
            update('php'),
            update('npm'),
        ];
        expect(devToolRows(updates).map((r) => r.name)).toEqual(['git', 'docker', 'composer']);
        expect(agentCliRows(updates).map((r) => r.name)).toEqual(['claude-code', 'codex']);
    });

    it('keeps the tab order stable regardless of the order main answers in', () => {
        const updates = [update('composer'), update('git'), update('docker')];
        expect(devToolRows(updates).map((r) => r.name)).toEqual(['git', 'docker', 'composer']);
    });
});

describe('an install row says WHICH install it is', () => {
    it('carries the source and the real directory — the actual question on this machine', () => {
        const row = installRowView(herd, undefined);
        expect(row.sourceLabel).toBe('Herd');
        expect(row.path).toBe('C:\\Users\\x\\.config\\herd\\bin\\php84');
        expect(row.managed).toBe(false);
    });

    it('offers nothing on a foreign row — it is there to be legible, not usable', () => {
        const row = installRowView(herd, undefined);
        expect(row.canSetDefault).toBe(false);
        expect(row.canRemove).toBe(false);
        expect(row.note).toMatch(/not managed by Genie/i);
    });

    it('offers Set default + Remove on a Genie row that is not already the default', () => {
        const row = installRowView(gen('8.2.33'), '8.3.33');
        expect(row.canSetDefault).toBe(true);
        expect(row.canRemove).toBe(true);
        expect(row.isDefault).toBe(false);
    });

    it('does not offer to make the default the default again', () => {
        const row = installRowView(gen('8.3.33'), '8.3.33');
        expect(row.isDefault).toBe(true);
        expect(row.canSetDefault).toBe(false);
        // Removing the default IS allowed — the page just has to say what takes
        // over, which is planVersionRemoval's job in main.
        expect(row.canRemove).toBe(true);
    });

    it('shows the disk a Genie version occupies, and nothing for one it did not measure', () => {
        expect(installRowView(gen('8.3.33'), undefined).sizeLabel).toBe('90 MB');
        expect(installRowView(herd, undefined).sizeLabel).toBeUndefined();
    });
});

describe('sizes read as sizes', () => {
    it('formats bytes at a human scale', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(900)).toBe('900 B');
        expect(formatBytes(1_048_576)).toBe('1.0 MB');
        expect(formatBytes(94_371_840)).toBe('90 MB');
        expect(formatBytes(2_147_483_648)).toBe('2.0 GB');
    });
});

describe('grouping the Languages tab', () => {
    const installs: EngineInstall[] = [
        gen('8.3.33'),
        gen('8.2.33'),
        herd,
        { ...gen('24.19.0'), tool: 'node', dir: 'C:\\g\\toolchain\\node\\24.19.0', exe: 'x' },
    ];

    it('gives every one of the five languages a section, even an empty one', () => {
        const sections = languageSections({
            installs,
            defaults: { php: '8.3.33' },
            addable: {},
            sites: [],
        });
        expect(sections.map((s) => s.tool)).toEqual(['php', 'node', 'python', 'go', 'rust']);
    });

    it('marks the default and lists Genie\u2019s installs before the foreign ones', () => {
        const php = languageSections({
            installs,
            defaults: { php: '8.3.33' },
            addable: {},
            sites: [],
        })[0]!;
        expect(php.defaultVersion).toBe('8.3.33');
        expect(php.rows.map((r) => `${r.sourceLabel}:${r.version}`)).toEqual([
            'Genie:8.3.33',
            'Genie:8.2.33',
            'Herd:8.4.1',
        ]);
        expect(php.rows[0]!.isDefault).toBe(true);
    });

    it('says what a language with nothing installed needs, per platform honesty', () => {
        const rust = languageSections({
            installs,
            defaults: {},
            addable: { rust: [] },
            sites: [],
        }).find((s) => s.tool === 'rust')!;
        expect(rust.rows).toEqual([]);
        expect(rust.defaultVersion).toBeUndefined();
        expect(rust.canAdd).toBe(false);
        expect(rust.emptyNote).toMatch(/no installer/i);
    });

    it('offers Add when this release has a recipe the machine does not have yet', () => {
        const go = languageSections({
            installs,
            defaults: {},
            addable: { go: ['1.26.6', '1.25.13'] },
            sites: [],
        }).find((s) => s.tool === 'go')!;
        expect(go.canAdd).toBe(true);
        expect(go.addable).toEqual(['1.26.6', '1.25.13']);
        expect(go.emptyNote).toMatch(/Add a version/i);
    });

    it('counts the sites on each language so the section says who cares', () => {
        const sites: ToolchainSiteUse[] = [
            { genName: 'web.tynn.gen', tool: 'php' },
            { genName: 'api.tynn.gen', tool: 'php', version: '8.2.33' },
            { genName: 'ui.fancy.gen', tool: 'node' },
        ];
        const php = languageSections({ installs, defaults: { php: '8.3.33' }, addable: {}, sites })[0]!;
        expect(php.usedBy).toBe('Used by 2 sites: web.tynn.gen (default), api.tynn.gen (8.2.33)');
    });

    it('says nothing about sites when there are none', () => {
        const php = languageSections({ installs, defaults: {}, addable: {}, sites: [] })[0]!;
        expect(php.usedBy).toBeUndefined();
    });
});

describe('changing the default NAMES what it moves', () => {
    const sites: ToolchainSiteUse[] = [
        { genName: 'web.tynn.gen', tool: 'php' },
        { genName: 'api.tynn.gen', tool: 'php', version: '8.2.33' },
        { genName: 'admin.tynn.gen', tool: 'php' },
        { genName: 'ui.fancy.gen', tool: 'node' },
    ];

    it('follows the default only for sites that have not pinned a version', () => {
        expect(sitesFollowingDefault(sites, 'php').map((s) => s.genName)).toEqual([
            'web.tynn.gen',
            'admin.tynn.gen',
        ]);
    });

    it('names the sites and says WHEN they change — never a bare "saved"', () => {
        const note = defaultChangeNotice('php', '8.2.33', sites);
        expect(note).toContain('PHP 8.2.33 is now the default');
        expect(note).toContain('web.tynn.gen');
        expect(note).toContain('admin.tynn.gen');
        expect(note).toContain('next start');
        // A pinned site is NOT affected, so it must not be named as if it were.
        expect(note).not.toContain('api.tynn.gen');
    });

    it('is still a visible confirmation when nothing is affected', () => {
        const note = defaultChangeNotice('go', '1.26.6', sites);
        expect(note).toContain('Go 1.26.6 is now the default');
        expect(note).toMatch(/No site/i);
    });
});

describe('removing a version tells you what it costs', () => {
    it('names the version, the disk it frees and the default that takes over', () => {
        const msg = removeConfirmation(gen('8.3.33'), { nextDefault: '8.2.33', freedBytes: 94_371_840 });
        expect(msg).toContain('PHP 8.3.33');
        expect(msg).toContain('90 MB');
        expect(msg).toContain('8.2.33');
    });

    it('warns when the last managed version of a language is going', () => {
        const msg = removeConfirmation(gen('8.3.33'), { nextDefault: null });
        expect(msg).toMatch(/no managed PHP/i);
    });
});
