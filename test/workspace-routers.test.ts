import { describe, expect, it } from 'vitest';
import { writeAgentRouters, type RouterFs } from '../src/main/agent-routers.js';

/**
 * THE ROUTERS AND RULES.md, DONE RIGHT — and Genie 1's damage repaired (the owner: Genie 2 manages all the workspace
 * agent files and upgrades them; "workspace agents cannot be left stranded").
 *
 * AGENTS.md and CLAUDE.md are routers that import README.md, RULES.md, the protocol and the provider file. Genie 1:
 *  - wrote CLAUDE.md THROUGH a git symlink to AGENTS.md, so AGENTS.md held the Claude router and codex read Claude's file;
 *  - recognised its own routers by exact text, so every older router shape (and any CRLF) was "user content" and
 *    migrated into RULES.md again, each time as a new block starting at `### Source 1`;
 *  - left an unbalanced `<!-- END GENIE MCP … -->` inside a migrated block.
 * Genie 2 replaces a symlinked CLAUDE.md with a real file, recognises a router of ANY Genie shape, migrates only a
 * person's text, once, and repairs RULES.md: router-only and duplicate migrated sections go, stray Genie markers go,
 * everything outside Genie's migration blocks stays byte-for-byte. Every rewritten file is backed up first.
 */
function memFs(files: Record<string, string>, symlinks: string[] = []) {
    const store = new Map(Object.entries(files));
    const links = new Set(symlinks);
    const fs: RouterFs = {
        read: async (p) => store.get(p) ?? null,
        write: async (p, t) => { if (links.has(p)) throw new Error(`wrote THROUGH the symlink ${p}`); store.set(p, t); },
        isSymlink: async (p) => links.has(p),
        unlink: async (p) => { links.delete(p); store.delete(p); },
        exists: async (p) => store.has(p) || links.has(p),
    };
    return { fs, store };
}
const W = '/w/ws';
const run = (fs: RouterFs) => writeAgentRouters({ workspacePath: W, fs, stamp: '20261012' });

const routerFor = (harness: 'codex' | 'claude', readme = true) =>
    ['# Agent instructions', '', ...(readme ? ['@README.md'] : []), '@RULES.md', '@.agents/_genie/shared.md', `@.agents/_genie/genie-${harness}.md`, ''].join('\n');

describe('the routers', () => {
    it('are written for each harness, importing what exists', async () => {
        const { fs, store } = memFs({ [`${W}/README.md`]: '# ws' });
        await run(fs);
        expect(store.get(`${W}/AGENTS.md`)).toBe(routerFor('codex'));
        expect(store.get(`${W}/CLAUDE.md`)).toBe(routerFor('claude'));
        expect(store.get(`${W}/RULES.md`)).toBe('# Workspace rules\n');
    });

    it('a CLAUDE.md that is a symlink is replaced by a real file, never written through; AGENTS.md keeps the codex router', async () => {
        const { fs, store } = memFs({ [`${W}/AGENTS.md`]: routerFor('claude'), [`${W}/README.md`]: '# ws', [`${W}/RULES.md`]: '# Workspace rules\n' }, [`${W}/CLAUDE.md`]);
        await run(fs);
        expect(store.get(`${W}/CLAUDE.md`)).toBe(routerFor('claude'));
        expect(store.get(`${W}/AGENTS.md`)).toBe(routerFor('codex'));
    });
});

describe('migration', () => {
    it('a person\'s own text moves to RULES.md once, backed up first; an old Genie router (any shape, CRLF) is not migrated', async () => {
        const proseRouter = 'Before doing work, read and follow these instruction sources (do not assume `@` imports are expanded):\r\n\r\n- README.md\r\n- .agents/_genie/shared.md\r\n';
        const { fs, store } = memFs({
            [`${W}/AGENTS.md`]: '# My project\n\nAlways run the tests before committing.\n',
            [`${W}/CLAUDE.md`]: proseRouter,
        });
        await run(fs);
        const rules = store.get(`${W}/RULES.md`)!;
        expect(rules).toContain('Always run the tests before committing.');
        expect(rules).not.toContain('Before doing work, read and follow');
        expect(store.get(`${W}/.agents/_genie/backups/AGENTS.md.20261012.bak`)).toBe('# My project\n\nAlways run the tests before committing.\n');
        await run(fs);
        const second = store.get(`${W}/RULES.md`)!;
        expect(second.match(/Always run the tests before committing\./g)).toHaveLength(1);
        // Idempotent: a third sync changes nothing.
        await run(fs);
        expect(store.get(`${W}/RULES.md`)).toBe(second);
    });
});

describe('repairing a Genie 1 RULES.md', () => {
    it('router-only and duplicate migrated sections go, stray markers go, a person\'s text stays byte-for-byte', async () => {
        const rules = [
            '# Workspace rules',
            '',
            'Keep the controller thin.',
            '',
            '<!-- BEGIN GENIE INSTRUCTION MIGRATION -->',
            '## Migrated agent instructions',
            '',
            '### Source 1',
            '',
            '# Old instructions',
            '',
            'Use the cache store for challenges.',
            '<!-- END GENIE MCP (auto-managed by Genie) -->',
            '<!-- END GENIE INSTRUCTION MIGRATION -->',
            '',
            '<!-- BEGIN GENIE INSTRUCTION MIGRATION -->',
            '## Migrated agent instructions',
            '',
            '### Source 1',
            '',
            '@.agents/_genie/shared.md',
            '@.agents/_genie/genie-claude.md',
            '<!-- END GENIE INSTRUCTION MIGRATION -->',
            '',
            '<!-- BEGIN GENIE INSTRUCTION MIGRATION -->',
            '## Migrated agent instructions',
            '',
            '### Source 1',
            '',
            '# Old instructions',
            '',
            'Use the cache store for challenges.',
            '<!-- END GENIE INSTRUCTION MIGRATION -->',
            '',
        ].join('\n');
        const { fs, store } = memFs({ [`${W}/RULES.md`]: rules, [`${W}/AGENTS.md`]: routerFor('codex', false), [`${W}/CLAUDE.md`]: routerFor('claude', false) });
        await run(fs);
        const out = store.get(`${W}/RULES.md`)!;
        expect(out.startsWith('# Workspace rules\n\nKeep the controller thin.\n')).toBe(true);
        expect(out.match(/Use the cache store for challenges\./g)).toHaveLength(1);
        expect(out).not.toContain('@.agents/_genie/shared.md');
        expect(out).not.toContain('END GENIE MCP');
        expect(out.match(/BEGIN GENIE INSTRUCTION MIGRATION/g)).toHaveLength(1);
        expect(store.get(`${W}/.agents/_genie/backups/RULES.md.20261012.bak`)).toBe(rules);
    });

    it('an already-clean workspace is left exactly as it is: nothing rewritten, nothing backed up (positive control)', async () => {
        const files = { [`${W}/AGENTS.md`]: routerFor('codex', false), [`${W}/CLAUDE.md`]: routerFor('claude', false), [`${W}/RULES.md`]: '# Workspace rules\n\nKeep the controller thin.\n' };
        const { fs, store } = memFs(files);
        await run(fs);
        for (const [p, t] of Object.entries(files)) expect(store.get(p)).toBe(t);
        expect([...store.keys()].some((k) => k.includes('/backups/'))).toBe(false);
    });
});
