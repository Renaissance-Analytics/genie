import { describe, expect, it } from 'vitest';
import {
    AGENT_CLI_CATALOG,
    AGENT_CLI_IDS,
    agentCliDef,
    agentCliForProvider,
    agentCliSpecs,
    installableAgentClis,
    npmPackagesByTool,
} from '../agent-cli-catalog';
import { PROVIDER_IDS, TUI_REGISTRY } from '../registry';

/**
 * The ONE table of agent CLIs Genie can detect and install.
 *
 * ## The fault this closes
 *
 * The Toolchain page's Agent CLIs tab derived its membership from a hardcoded
 * `['claude-code', 'codex']` in the renderer. It read as "what agent CLIs does
 * this machine have" and actually meant "the two names we wrote down" — so a
 * provider the registry already carried (Genie TUI, Kiwi Code) could never
 * appear there, and the owner found out only when a terminal died with
 * `bash: genie: command not found`.
 *
 * Two names for the same fact, one of them unenforced, is the same shape
 * `registry.ts` was written to end. So the toolchain's agent-CLI set derives
 * from THIS table, and this table is required to cover every provider that
 * names a fixed binary — a claim the type system makes for the compiler and
 * these tests make for a human reading the failure.
 */

describe('the catalog covers every provider that names a binary', () => {
    it('has an entry for each provider with a fixed defaultCommand', () => {
        const uncovered = PROVIDER_IDS.filter(
            (id) => TUI_REGISTRY[id].defaultCommand !== '' && !agentCliForProvider(id),
        );
        expect(uncovered).toEqual([]);
    });

    it('lists the Genie TUI, the provider whose absence started this', () => {
        const genie = agentCliForProvider('genie');
        expect(genie).toBeDefined();
        expect(genie!.bin).toBe('genie');
    });

    it('claims no provider that has no binary to claim — custom is the owner’s own command', () => {
        expect(agentCliForProvider('custom')).toBeUndefined();
    });

    it('never disagrees with the registry about the binary — the `genie-tui` bug, one layer on', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (!entry.provider) continue;
            expect(entry.bin).toBe(TUI_REGISTRY[entry.provider].defaultCommand);
        }
    });

    it('never disagrees with the registry about the NAME either', () => {
        // The agent picker and the Toolchain page name the same product. Two
        // spellings of it is how a person ends up unsure whether "Claude Code"
        // in Settings is the thing they picked in the rail.
        for (const entry of AGENT_CLI_CATALOG) {
            if (!entry.provider) continue;
            expect(entry.label, entry.id).toBe(TUI_REGISTRY[entry.provider].label);
        }
    });
});

describe('every entry is a usable detection recipe', () => {
    it('gives each tool a unique id and a unique binary', () => {
        expect(new Set(AGENT_CLI_IDS).size).toBe(AGENT_CLI_IDS.length);
        const bins = AGENT_CLI_CATALOG.map((e) => e.bin);
        expect(new Set(bins).size).toBe(bins.length);
    });

    it('can ask every tool for a version', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            expect(entry.versionArgv.length).toBeGreaterThan(0);
        }
    });

    it('produces a probe spec per tool, keyed by id and spawning the BIN', () => {
        const specs = agentCliSpecs();
        expect(Object.keys(specs).sort()).toEqual([...AGENT_CLI_IDS].sort());
        expect(specs['claude-code']!.bin).toBe('claude');
        expect(specs['claude-code']!.name).toBe('claude-code');
    });
});

describe('a gap is stated, never hidden', () => {
    it('makes an uninstallable tool SAY why, so a row can show the gap instead of a dead button', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (entry.install) continue;
            expect(entry.installGap, `${entry.id} has no installer and no reason`).toBeTruthy();
        }
    });

    it('points every tool Genie cannot install at somewhere the person can', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (entry.install) continue;
            // `kiwi` is the one exception, and it is the honest one: there is no
            // documentation to link because no such product could be found.
            if (entry.id === 'kiwi') continue;
            expect(entry.docsUrl, `${entry.id} has no docs URL`).toMatch(/^https:\/\//);
        }
    });

    it('never links anywhere but https', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (entry.docsUrl === undefined) continue;
            expect(entry.docsUrl, entry.id).toMatch(/^https:\/\//);
        }
    });

    it('separates what Genie CAN install from what it merely knows about', () => {
        const installable = installableAgentClis().map((e) => e.id);
        expect(installable).toContain('claude-code');
        expect(installable).toContain('codex');
        // Genie's own TUI is not published yet — the honest state is a listed
        // gap, never a silent absence and never an installer that would fail.
        expect(installable).not.toContain('genie');
    });
});

describe('the npm packages the installer and the update check share', () => {
    it('keeps the two shipping tools exactly as they are — a rename here is a silent breakage', () => {
        expect(npmPackagesByTool()['claude-code']).toBe('@anthropic-ai/claude-code');
        expect(npmPackagesByTool()['codex']).toBe('@openai/codex');
    });

    it('maps every npm-installable tool, and only those', () => {
        const mapped = Object.keys(npmPackagesByTool()).sort();
        const expected = AGENT_CLI_CATALOG.filter((e) => e.install?.manager === 'npm')
            .map((e) => e.id)
            .sort();
        expect(mapped).toEqual(expected);
    });

    it('names a scoped package exactly once per tool', () => {
        const packages = Object.values(npmPackagesByTool());
        expect(new Set(packages).size).toBe(packages.length);
    });
});

describe('the list the owner asked to be expanded', () => {
    it('is no longer two', () => {
        expect(AGENT_CLI_IDS.length).toBeGreaterThan(2);
    });

    it('carries the agents whose CLIs were verified against their own package manifests', () => {
        for (const id of ['gemini-cli', 'opencode', 'copilot-cli', 'crush', 'amp'] as const) {
            expect(agentCliDef(id)?.install?.manager).toBe('npm');
        }
    });
});
