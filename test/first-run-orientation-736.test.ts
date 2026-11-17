import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasProjectRules, sharedProtocol } from '../src/core/genie-protocol.js';
import { writeAgentProtocol, type SyncFs } from '../src/main/config-sync-targets.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { writeGenieInstructions } from '../src/main/genie-instructions.js';

/**
 * A FRESH AGENT'S FIRST RUN (Tynn #736, #737; LiftPoint onboarding, 2026-11-16). The client's first agent in a new
 * workspace was asked "show me what you can do": it had generic files only, and went to a generic ToolSearch. The owner:
 * "I wonder why it didn't use the help or use the docs first". Genie's guide for agents is its `genie` skill (and the
 * `genie-*` ones): skills are listed with their descriptions in every Claude Code session, while Genie's MCP tools are
 * deferred behind ToolSearch, so the guide has to be named, in the protocol and in the skill's own description, as the
 * first stop. And while the workspace has no rules, the protocol carries a short first-run orientation that sends the
 * agent to that guide and offers the Fancy Dev Kit plugin, with the real install commands (#737: "the fancy plugin
 * automatically will be recommended for agents their first run in Genie").
 */
function memFs(files: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(files));
    let writes = 0;
    const fs: SyncFs = {
        read: async (p) => store.get(p) ?? null,
        write: async (p, t) => { writes++; store.set(p, t); },
        remove: async (p) => { store.delete(p); },
        list: async (dir) => [...store.keys()].filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/')).map((k) => k.slice(dir.length + 1)),
    };
    return { fs, store, writes: () => writes };
}
const W = '/w/example';
const SHARED = `${W}/.agents/_genie/shared.md`;
const RULES = `${W}/RULES.md`;
const tools = [{ name: 'imDone', description: 'x' }];

/** The guide line: the `genie` skill is Genie's guide, read first, before searching for tools. */
const GUIDE = /`genie` skill[^\n]*Genie['’]s guide[^\n]*before[^\n]*search/i;
const FIRST_RUN = '## First run here';
const FANCY = [
    /Fancy Dev Kit/,
    /claude plugin marketplace add Particle-Academy\/fancy-ui-plugin/,
    /claude plugin install fancy-ui@fancy-ui/,
    /codex plugin marketplace add Particle-Academy\/fancy-ui-codex-plugin/,
    /codex plugin add fancy-ui@fancy-ui/,
];

function section(md: string): string | undefined {
    const at = md.indexOf(FIRST_RUN);
    if (at < 0) return undefined;
    const rest = md.slice(at + FIRST_RUN.length);
    const end = rest.search(/\n## |\nWorkspace rules are in/);
    return rest.slice(0, end < 0 ? undefined : end);
}

async function synced(files: Record<string, string> = {}) {
    const m = memFs(files);
    await writeAgentProtocol({ workspacePath: W, fs: m.fs, enabled: true, tools, tracking: 'tynn' });
    return m;
}

let home: string | null = null;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = null; });

describe('Genie names its own guide as the first stop (#736)', () => {
    it('shared.md says the `genie` skill is Genie\'s guide, to read before searching for tools, signed in to Tynn or not', () => {
        for (const tracking of ['tynn', 'files'] as const) expect(sharedProtocol(tools, tracking), tracking).toMatch(GUIDE);
    });

    it('the `genie` skill\'s own description says it is Genie\'s guide and to read it first', () => {
        const genie = GENIE_SKILLS.find((s) => s.name === 'genie')!;
        expect(genie.description).toMatch(/^Genie['’]s guide/);
        expect(genie.description).toMatch(/first/i);
    });

    it('the prompt for an agent in an untrusted workspace names the guide too', async () => {
        home = await mkdtemp(join(tmpdir(), 'genie-736-'));
        const files = await writeGenieInstructions(home, tools, 'files');
        expect(await readFile(files.promptFile, 'utf8')).toMatch(GUIDE);
        expect(files.codexPromptText).toMatch(GUIDE);
    });
});

describe('a first-run orientation while the workspace has no rules (#736, #737)', () => {
    it('no RULES.md yet: shared.md carries the orientation, the guide and the Fancy Dev Kit with its install commands', async () => {
        const { store } = await synced();
        const s = section(store.get(SHARED)!);
        expect(s, 'orientation').toBeDefined();
        expect(s).toMatch(/`genie` skill/);
        for (const f of FANCY) expect(s, String(f)).toMatch(f);
    });

    it('RULES.md holding only Genie\'s own heading is still a workspace with no rules', async () => {
        expect(hasProjectRules('# Workspace rules\n')).toBe(false);
        expect(hasProjectRules('# Workspace rules\r\n\r\n## Notes\r\n')).toBe(false);
        expect(hasProjectRules(null)).toBe(false);
        const { store } = await synced({ [RULES]: '# Workspace rules\n' });
        expect(section(store.get(SHARED)!)).toBeDefined();
    });

    it('CONTROL: a workspace with rules gets no orientation and no Fancy offer', async () => {
        const { store } = await synced({ [RULES]: '# Workspace rules\n\nUse pnpm. Ship from main.\n' });
        const md = store.get(SHARED)!;
        expect(md).not.toContain(FIRST_RUN);
        expect(md).not.toMatch(/Fancy Dev Kit/);
    });

    it('once the workspace has rules, the next sync takes the orientation out', async () => {
        const m = await synced();
        expect(m.store.get(SHARED)).toContain(FIRST_RUN);
        m.store.set(RULES, '# Workspace rules\n\nUse pnpm.\n');
        await writeAgentProtocol({ workspacePath: W, fs: m.fs, enabled: true, tools, tracking: 'tynn' });
        expect(m.store.get(SHARED)).not.toContain(FIRST_RUN);
    });

    it('the orientation is short: under 120 words', async () => {
        const { store } = await synced();
        const s = section(store.get(SHARED)!);
        expect(s, 'orientation').toBeDefined();
        expect(s!.split(/\s+/).filter(Boolean).length).toBeLessThan(120);
    });

    it('CONTROL: a repeat sync with nothing changed writes nothing', async () => {
        const m = await synced();
        const before = m.writes();
        await writeAgentProtocol({ workspacePath: W, fs: m.fs, enabled: true, tools, tracking: 'tynn' });
        expect(m.writes()).toBe(before);
    });
});
