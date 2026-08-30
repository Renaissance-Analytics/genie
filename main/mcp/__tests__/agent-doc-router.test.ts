import { describe, expect, it } from 'vitest';
import { AGENT_DOC_FILES, agentDocsRouter } from '../agent-config';

describe('agentDocsRouter', () => {
    it('gives each harness only its own @ imports', () => {
        const codex = agentDocsRouter(AGENT_DOC_FILES.codex, { readme: true, rules: true });
        const claude = agentDocsRouter(AGENT_DOC_FILES.claude, { readme: true, rules: true });

        expect(codex).toBe('# Agent instructions\n\n@README.md\n@RULES.md\n@.agents/_genie/shared.md\n@.agents/_genie/genie-codex.md\n');
        expect(claude).toBe('# Agent instructions\n\n@README.md\n@RULES.md\n@.agents/_genie/shared.md\n@.agents/_genie/genie-claude.md\n');
        expect(codex).not.toContain('genie-claude.md');
        expect(claude).not.toContain('genie-codex.md');
    });

    it('only links workspace-owned context files that actually exist', () => {
        expect(agentDocsRouter(AGENT_DOC_FILES.codex, { readme: true, rules: false }))
            .toContain('@README.md\n@.agents/_genie/shared.md');
        expect(agentDocsRouter(AGENT_DOC_FILES.codex, { readme: false, rules: true }))
            .toContain('@RULES.md\n@.agents/_genie/shared.md');
        expect(agentDocsRouter(AGENT_DOC_FILES.codex, { readme: false, rules: false }))
            .not.toMatch(/@(?:README|RULES)\.md/);
    });

    it('defaults legacy and unknown callers to the Codex AGENTS.md router', () => {
        expect(agentDocsRouter('anything.md')).toBe(agentDocsRouter('AGENTS.md'));
    });
});
