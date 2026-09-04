import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    agentScopeFor,
    parseAgentFile,
    renderAgentFile,
    type AgentFileConfig,
} from '../agent-file';

/**
 * `.agents/<slug>/AGENT.md` — an agent's config AND its system prompt, in one
 * file the project commits.
 *
 * The path has existed since `registerAgent` shipped (`registration.ts` computes
 * it and stores it as `persona_path`) and NOTHING has ever written it. Launch
 * only mentions it when the file happens to exist, so every registered agent has
 * booted with no persona at all.
 *
 * The owner's decision: config lives in frontmatter and the file is tracked in
 * git, so an agent ships with the project and a teammate cloning the repo gets
 * it. That makes the FILE the source of truth and the DB a cache — which only
 * works if a human editing it by hand cannot break Genie.
 *
 * Shape deliberately mirrors the `SKILL.md` Genie already writes, so authoring
 * an agent and authoring a skill are one convention rather than two.
 */
describe('AGENT.md', () => {
    const config: AgentFileConfig = {
        name: 'tynn',
        purpose: 'Laravel app work',
        scope: 'repos/tynn',
        tuis: ['claude', 'codex'],
        avatar: '🧪',
        // Declared, so the round-trip below covers the `mode:` line too. Its
        // ABSENCE — the ordinary case — is pinned in `agent-mode.test.ts`.
        mode: 'automated',
    };

    it('round-trips config and prompt', () => {
        const parsed = parseAgentFile(renderAgentFile(config, 'You are the Tynn app agent.'));
        expect(parsed.config).toEqual(config);
        expect(parsed.body.trim()).toBe('You are the Tynn app agent.');
    });

    it('keeps the prompt body verbatim, including blank lines and markdown', () => {
        // The body IS the system prompt. Reflowing or trimming the middle of it
        // would silently change what the agent was told.
        const prompt = '# Role\n\nYou do two things:\n\n- one\n- two\n';
        expect(parseAgentFile(renderAgentFile(config, prompt)).body).toContain(
            '- one\n- two',
        );
    });

    it('reads a file a human wrote by hand, with loose spacing', () => {
        const raw = [
            '---',
            'name:   tynn',
            'purpose: Laravel app work',
            'tuis: [claude,   codex]',
            '---',
            '',
            'Be careful with migrations.',
        ].join('\n');
        const parsed = parseAgentFile(raw);
        expect(parsed.config.name).toBe('tynn');
        expect(parsed.config.tuis).toEqual(['claude', 'codex']);
        expect(parsed.body.trim()).toBe('Be careful with migrations.');
    });

    it('treats a file with no frontmatter as all prompt', () => {
        // Someone may write the prompt first and let Genie fill the header in.
        // Losing their text because the header is missing would be the worst
        // possible reading of a file they own.
        const parsed = parseAgentFile('Just do the thing.');
        expect(parsed.body.trim()).toBe('Just do the thing.');
        expect(parsed.config.name).toBe('');
    });

    it('survives a malformed header without discarding the prompt', () => {
        const parsed = parseAgentFile('---\nnot: [valid\n---\n\nThe prompt still matters.');
        expect(parsed.body.trim()).toBe('The prompt still matters.');
    });

    it('drops a tuis entry that is not a known provider', () => {
        // The list drives which TUIs an agent may be started under. An unknown
        // one would fail at launch, far from the file that caused it.
        const parsed = parseAgentFile(
            '---\nname: x\npurpose: y\ntuis: [claude, notatui]\n---\nbody',
        );
        expect(parsed.config.tuis).toEqual(['claude']);
    });

    it('defaults tuis to empty rather than guessing a driver', () => {
        // An agent is not its TUI. Inventing one here would put a driver on an
        // agent whose author deliberately left it open.
        const parsed = parseAgentFile('---\nname: x\npurpose: y\n---\nbody');
        expect(parsed.config.tuis).toEqual([]);
    });

    it('omits an empty scope rather than writing a misleading one', () => {
        // A blank `scope:` reads as "scoped to nothing"; absence reads as
        // "the whole workspace", which is the actual default.
        const rendered = renderAgentFile({ ...config, scope: null }, 'b');
        expect(rendered).not.toContain('scope:');
        expect(parseAgentFile(rendered).config.scope).toBeNull();
    });
});

/**
 * `scope` is written into a file the project COMMITS, so it must read the same
 * on every machine that clones it.
 *
 * `path.relative` hands back BACKSLASHES on Windows, which is where most of this
 * is developed. A separator that leaked through would put `scope: repos\tynn`
 * into a tracked file, which then fails to resolve for the teammate on Linux who
 * pulls it — a bug that cannot reproduce on the machine that wrote it.
 *
 * Written against the CURRENT platform's separator rather than a hardcoded
 * Windows path, because `C:\ws` is just a filename to Linux and the assertion
 * would be testing nothing on the CI that runs it most.
 */
describe('agentScopeFor', () => {
    const root = path.resolve('/ws');
    const nested = path.join(root, 'repos', 'tynn');

    it('is null for the workspace root, not "."', () => {
        // Absence means "the whole workspace"; `scope: .` reads as a deliberate
        // narrowing that isn't one.
        expect(agentScopeFor(root, root)).toBeNull();
    });

    it('emits POSIX separators whatever the platform hands back', () => {
        expect(agentScopeFor(root, nested)).toBe('repos/tynn');
    });

    it('never lets a backslash reach the committed file', () => {
        // The assertion that actually bites on Windows, and the one a hardcoded
        // POSIX fixture would have missed entirely.
        expect(agentScopeFor(root, nested)).not.toContain('\\');
    });
});
