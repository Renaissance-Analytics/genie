import { describe, expect, it } from 'vitest';
import { GENIE_AGENTS_IGNORE_RULES, gitignoreWithRules } from '../agent-config';

/**
 * `.agents/` becomes a TRACKED folder, so what Genie regenerates has to be
 * ignored — and only what Genie regenerates.
 *
 * The owner's decision: an agent's `AGENT.md` is committed, so agents ship with
 * the project and a change to one is reviewable like any other change. That only
 * works if the folder is not also full of files Genie rewrites on every sync,
 * which would make every workspace permanently dirty.
 *
 * The precision matters in one direction especially: `.agents/skills/` holds
 * BOTH Genie's managed skills and skills the user wrote — `agent-config.ts` says
 * so and guards deletion on the `genie-` prefix. Ignoring the folder wholesale
 * would quietly stop tracking the user's own work.
 */
describe('the .agents gitignore rules', () => {
    it('ignores what Genie regenerates', () => {
        expect(GENIE_AGENTS_IGNORE_RULES).toContain('.agents/_genie/');
    });

    it('does NOT ignore .agents wholesale — the agents themselves are the point', () => {
        expect(GENIE_AGENTS_IGNORE_RULES).not.toContain('.agents/');
        expect(GENIE_AGENTS_IGNORE_RULES).not.toContain('.agents');
    });

    it('does NOT ignore the skills folder wholesale — the user writes skills there too', () => {
        expect(GENIE_AGENTS_IGNORE_RULES).not.toContain('.agents/skills/');
    });

    it('scopes the skill rule to Genie’s own prefix', () => {
        expect(GENIE_AGENTS_IGNORE_RULES.some((r) => r.startsWith('.agents/skills/genie'))).toBe(
            true,
        );
    });

    it('adds missing rules to an existing file without disturbing it', () => {
        const before = 'node_modules\ndist\n';
        const after = gitignoreWithRules(before, ['.agents/_genie/'], 'Genie');
        expect(after.startsWith(before)).toBe(true);
        expect(after).toContain('.agents/_genie/');
    });

    it('is idempotent — a rule already present is not added twice', () => {
        // Sync runs on every workspace open. A rule appended each time would grow
        // the file without bound and show up as a diff every session.
        const once = gitignoreWithRules('', ['.agents/_genie/'], 'Genie');
        expect(gitignoreWithRules(once, ['.agents/_genie/'], 'Genie')).toBe(once);
    });

    it('adds only the rules that are actually missing', () => {
        const partial = gitignoreWithRules('', ['.agents/_genie/'], 'Genie');
        const both = gitignoreWithRules(partial, ['.agents/_genie/', '.agents/skills/genie*/'], 'Genie');
        expect(both.split('.agents/_genie/')).toHaveLength(2);
        expect(both).toContain('.agents/skills/genie*/');
    });

    it('creates a usable file from nothing', () => {
        const made = gitignoreWithRules('', ['.agents/_genie/'], 'Genie');
        expect(made.trim().split('\n').filter((l) => l.trim() === '.agents/_genie/')).toHaveLength(1);
    });

    it('does not concatenate onto a file with no trailing newline', () => {
        // `dist` and the rule sharing a line would make BOTH of them wrong, and
        // a .gitignore that silently stops ignoring `dist` is the kind of thing
        // nobody notices until a build directory lands in a PR.
        const after = gitignoreWithRules('dist', ['.agents/_genie/'], 'Genie');
        expect(after).not.toContain('dist.agents');
        expect(after.split('\n').some((l) => l.trim() === 'dist')).toBe(true);
    });
});
